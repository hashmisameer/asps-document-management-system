import path from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_SIGNATURE_MIME_TYPES,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_SIGNATURE_SIZE_BYTES,
  type AllowedDocumentMimeType,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from '../utils/errors.js'
import { MalformedImageError, assertDecodablePng } from './pngIntegrity.service.js'

/**
 * What an uploaded file is actually allowed to be.
 *
 * The decisive check is the file's own CONTENT, not its name and not the
 * Content-Type the browser attached: both are chosen by the caller. A .exe
 * renamed to .pdf, or sent with a Content-Type of application/pdf, is rejected
 * here because its first bytes are not a PDF's.
 *
 * The name still has to agree with the content, so a PDF uploaded as
 * 'payslip.png' is refused too - not because it is dangerous, but because
 * everything downstream, from the preview to the signature stamping, decides
 * what to do from the type, and a file that lies about itself will fail there
 * instead, further from the person who could fix it.
 *
 * AND THE FILE IS THEN OPENED. Knowing what a file claims to be is not the same
 * as knowing it works: a half-downloaded PDF still begins '%PDF-'. See
 * assertOpensCleanly, which is the difference between catching that here and
 * discovering it weeks later, when somebody prints the employee's file.
 *
 * Everything in this module runs BEFORE anything is written. A file refused
 * here leaves nothing behind - no bytes in the store, no row changed, the
 * document still Pending - because at the moment it is refused, nothing has
 * happened yet.
 */

export interface InspectedFile {
  /** Lower-case, with the leading dot. */
  extension: string
  mimeType: AllowedDocumentMimeType
  /** The uploaded name with any path stripped, safe to store and to send back. */
  safeOriginalName: string
}

export interface UploadedFile {
  originalname: string
  buffer: Buffer
  size: number
}

/** Extensions that legitimately carry each accepted type. */
const EXTENSIONS_BY_MIME: Readonly<Record<AllowedDocumentMimeType, readonly string[]>> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/tiff': ['.tif', '.tiff'],
}

/** The smaller of the business rule and the deployment's own ceiling. */
const maxBytes = Math.min(MAX_DOCUMENT_SIZE_BYTES, env.maxUploadBytes)

function isAllowedMime(value: string): value is AllowedDocumentMimeType {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(value)
}

/**
 * Strips everything but the file name.
 *
 * An uploaded name can contain 'C:\Users\...' or '../../', and control
 * characters that would mangle a Content-Disposition header. Only the base name
 * is kept, and it is never used to build a path on disk - that is a UUID.
 */
export function safeFileName(originalName: string): string {
  const base = path.basename(originalName.replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 260) : 'document'
}

export async function inspectDocumentUpload(file: UploadedFile): Promise<InspectedFile> {
  if (file.size === 0 || file.buffer.byteLength === 0) {
    throw new BadRequestError('That file is empty.')
  }
  if (file.buffer.byteLength > maxBytes) {
    throw new PayloadTooLargeError(
      `That file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
    )
  }

  const safeOriginalName = safeFileName(file.originalname)
  const extension = path.extname(safeOriginalName).toLowerCase()

  if (!(ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new UnsupportedMediaTypeError(
      `Only ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')} files can be uploaded.`,
    )
  }

  const detected = await fileTypeFromBuffer(file.buffer)

  if (!detected || !isAllowedMime(detected.mime)) {
    throw new UnsupportedMediaTypeError(
      'That file is not one this system can read. Upload a PDF, JPEG, PNG, WebP or TIFF - ' +
        'and check that the file opens on your own machine.',
    )
  }

  if (!EXTENSIONS_BY_MIME[detected.mime].includes(extension)) {
    throw new UnsupportedMediaTypeError(
      `That file is named ${extension} but its contents are ${detected.mime}. ` +
        `Rename it to match, or upload the original file.`,
    )
  }

  await assertOpensCleanly(file.buffer, detected.mime)

  return { extension, mimeType: detected.mime, safeOriginalName }
}

/**
 * Opens the file for real, and refuses it if it will not open.
 *
 * THE GAP THIS CLOSES. Everything above reads the first few bytes: enough to
 * know a file is not an .exe wearing a .pdf name, and nothing at all about
 * whether the rest of it survived. A PDF whose download was cut off still
 * begins '%PDF-', so it passed every check and was filed as received - and the
 * damage surfaced weeks later when somebody tried to print the employee's file
 * and half of it was missing.
 *
 * THIS IS THE ONE PLACE WHERE BLOCKING AN UPLOAD IS RIGHT, and it is worth
 * being clear how it differs from the identity check, which blocks nothing. OCR
 * failing to read a name means the READING failed; the document is a perfectly
 * good photocopy and belongs on the record. This means the FILE is broken -
 * unopenable now and unopenable in five years, when somebody needs it.
 *
 * The work is deliberately shallow: the file is opened and asked how many pages
 * it has, or how large the image is. That is what catches a truncated or
 * corrupt file. Rendering every page to be sure none of them is damaged would
 * cost seconds per upload to catch almost nothing more.
 */
async function assertOpensCleanly(buffer: Buffer, mime: AllowedDocumentMimeType): Promise<void> {
  if (mime === 'application/pdf') {
    let pageCount: number
    try {
      // ignoreEncryption, because a scan from an office photocopier is often
      // 'encrypted' with an empty owner password - which stops nothing, and
      // which those files have always been accepted with.
      const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
      pageCount = pdf.getPageCount()
    } catch {
      throw new BadRequestError(
        'This PDF could not be opened - it may be damaged, or protected with a password. ' +
          'Check that it opens on your own machine, then upload it again.',
      )
    }

    // A PDF with no pages parses perfectly and contains nothing. Preview shows
    // an empty window, the employee file gains nothing, and the checklist says
    // the document is in.
    if (pageCount === 0) {
      throw new BadRequestError(
        'This PDF has no pages in it. Check the file, then upload it again.',
      )
    }
    return
  }

  // A PNG is proved by its own chunk structure - see pngIntegrity.service.ts,
  // which exists because a PNG that ends early sends pdf-lib's decoder into a
  // loop on the one thread that serves every request.
  if (mime === 'image/png') {
    try {
      assertDecodablePng(buffer)
    } catch (error) {
      if (error instanceof MalformedImageError) {
        throw new BadRequestError(`${error.message} Try exporting or scanning it again.`)
      }
      throw error
    }
    return
  }

  // JPEG, WebP and TIFF: sharp reads the header and the structure behind it,
  // and a file that has lost its end has no dimensions to report.
  try {
    const { width, height } = await sharp(buffer, { failOn: 'error' }).metadata()
    if (!width || !height) throw new Error('no dimensions')
  } catch {
    throw new BadRequestError(
      'This image could not be read - the file looks damaged. Scan or export it again, ' +
        'then upload it.',
    )
  }
}

/**
 * A signature image.
 *
 * Narrower than a document on purpose: PNG or JPEG only, and much smaller. A
 * signature is a small transparent crop, not a scan - and PDF is excluded
 * because the stamper draws an image onto a page, not a page onto a page.
 */
export async function inspectSignatureUpload(file: UploadedFile): Promise<InspectedFile> {
  if (file.buffer.byteLength === 0) {
    throw new BadRequestError('That file is empty.')
  }
  if (file.buffer.byteLength > MAX_SIGNATURE_SIZE_BYTES) {
    throw new PayloadTooLargeError(
      `A signature image must be under ${Math.floor(MAX_SIGNATURE_SIZE_BYTES / (1024 * 1024))} MB.`,
    )
  }

  const detected = await fileTypeFromBuffer(file.buffer)

  if (!detected || !(ALLOWED_SIGNATURE_MIME_TYPES as readonly string[]).includes(detected.mime)) {
    throw new UnsupportedMediaTypeError(
      'A signature must be a PNG or JPEG image. A PNG with a transparent background works best.',
    )
  }

  // A PNG is proved whole before anything tries to decode it. pdf-lib decodes
  // a PNG's pixels to embed it, and a file whose image data ends early sends it
  // into a loop on the one thread that serves every request - so a single bad
  // upload would take the API down for everyone. A JPEG needs no equivalent
  // check: pdf-lib reads its header for the dimensions and never decodes it.
  if (detected.mime === 'image/png') {
    try {
      assertDecodablePng(file.buffer)
    } catch (error) {
      if (error instanceof MalformedImageError) {
        throw new BadRequestError(`${error.message} Try exporting or scanning it again.`)
      }
      throw error
    }
  }

  const safeOriginalName = safeFileName(file.originalname)
  return {
    // The extension comes from the CONTENT, not from the name: this file is
    // never shown to anyone by name, and the stamper picks its decoder from it.
    extension: detected.mime === 'image/png' ? '.png' : '.jpg',
    mimeType: detected.mime as AllowedDocumentMimeType,
    safeOriginalName,
  }
}
