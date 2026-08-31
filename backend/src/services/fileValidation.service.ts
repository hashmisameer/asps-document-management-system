import path from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
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
      'That file is not a PDF, JPEG or PNG. Check that it opens on your own machine.',
    )
  }

  if (!EXTENSIONS_BY_MIME[detected.mime].includes(extension)) {
    throw new UnsupportedMediaTypeError(
      `That file is named ${extension} but its contents are ${detected.mime}. ` +
        `Rename it to match, or upload the original file.`,
    )
  }

  return { extension, mimeType: detected.mime, safeOriginalName }
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

  const safeOriginalName = safeFileName(file.originalname)
  return {
    // The extension comes from the CONTENT, not from the name: this file is
    // never shown to anyone by name, and the stamper picks its decoder from it.
    extension: detected.mime === 'image/png' ? '.png' : '.jpg',
    mimeType: detected.mime as AllowedDocumentMimeType,
    safeOriginalName,
  }
}
