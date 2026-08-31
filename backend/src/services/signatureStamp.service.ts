import { PDFDocument, degrees, type PDFImage, type PDFPage } from 'pdf-lib'
import {
  SIGNER_ROLES,
  normalizeRotation,
  toPdfUserSpace,
  type NormalizedRect,
  type PageRotation,
  type SignerRole,
} from '@asps-dms/shared'
import { BadRequestError, ConflictError, UnsupportedMediaTypeError } from '../utils/errors.js'

/**
 * Drawing a signature onto a document.
 *
 * Two rules, both from the specification and both absolute:
 *
 *   1. The output is ALWAYS regenerated from the ORIGINAL (Sections 34 and 64).
 *      Stamping a previously stamped file would compound every placement that
 *      was ever made, and a corrected placement would leave the wrong one
 *      underneath it.
 *   2. The output is always a PDF, whatever went in (open question Q8). An image
 *      document becomes a single-page PDF sized to the image, so there is one
 *      output format to preview, download and print.
 */

export interface StampPlacement {
  pageNumber: number
  rect: NormalizedRect
  /** The rotation the page had when HR positioned this - see below. */
  pageRotation: PageRotation
  /** Whose signature goes in this box. Defaults to the employee's. */
  signerRole?: SignerRole
}

export interface SignatureImage {
  data: Buffer
  /** 'image/png' or 'image/jpeg'. */
  mimeType: string
}

export interface StampInput {
  source: Buffer
  /** 'application/pdf', 'image/png' or 'image/jpeg'. */
  sourceMimeType: string
  /**
   * One image per signer role.
   *
   * A map rather than a single image because a document carries two marks: the
   * employee's, and the authorising HR user's. Each is embedded at most once
   * however many boxes it fills - a signature embedded per placement would put
   * the same bytes in the file several times over.
   */
  signatures: Partial<Record<SignerRole, SignatureImage>>
  placements: readonly StampPlacement[]
}

/** What pdf-lib needs to draw the image so that it lands on the target rect. */
export interface DrawParams {
  x: number
  y: number
  width: number
  height: number
  /** Counter-clockwise degrees, as pdf-lib measures them. */
  rotate: 0 | 90 | 180 | 270
}

/**
 * Turns a normalized placement into pdf-lib draw parameters.
 *
 * toPdfUserSpace already answers "where on the unrotated page does this rect
 * land". This adds the part that is specific to DRAWING: a page with /Rotate 90
 * is turned clockwise by the viewer, and content drawn into it turns with it -
 * so an image drawn without compensation appears on its side. It is drawn
 * pre-rotated counter-clockwise by the same angle, which also moves the anchor,
 * because pdf-lib rotates about (x, y) rather than about the rect's centre.
 *
 * This lives here rather than in shared/utils/coordinates.ts on purpose: it
 * encodes pdf-lib's anchor-and-rotate semantics, which the browser editor has
 * no use for and must not start depending on. The coordinate CONTRACT stays in
 * the shared module, which both sides use.
 */
export function toDrawParams(
  rect: NormalizedRect,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation,
): DrawParams {
  const target = toPdfUserSpace(rect, pageWidth, pageHeight, rotation)

  switch (rotation) {
    case 0:
      return { x: target.x, y: target.y, width: target.width, height: target.height, rotate: 0 }
    case 90:
      // Rotated 90 CCW about (x, y), the image extends left and up, so the
      // anchor is the target's right edge; and its own width/height are the
      // target's swapped.
      return {
        x: target.x + target.width,
        y: target.y,
        width: target.height,
        height: target.width,
        rotate: 90,
      }
    case 180:
      return {
        x: target.x + target.width,
        y: target.y + target.height,
        width: target.width,
        height: target.height,
        rotate: 180,
      }
    case 270:
      return {
        x: target.x,
        y: target.y + target.height,
        width: target.height,
        height: target.width,
        rotate: 270,
      }
  }
}

async function embedSignature(pdf: PDFDocument, image: Buffer, mimeType: string): Promise<PDFImage> {
  try {
    return mimeType === 'image/png' ? await pdf.embedPng(image) : await pdf.embedJpg(image)
  } catch (error) {
    // pdf-lib cannot read a progressive JPEG. That is worth saying plainly:
    // "signature could not be embedded" would send HR looking at the document.
    throw new UnsupportedMediaTypeError(
      'That signature image cannot be embedded in a PDF. Re-save it as a PNG and upload it again.',
      { cause: error },
    )
  }
}

/**
 * Builds a one-page PDF around an image document.
 *
 * The page is the image's own pixel size in points, so the signature keeps the
 * proportions HR placed it with. Everything after this point treats an image
 * document and a PDF document identically.
 */
async function pdfFromImage(source: Buffer, mimeType: string): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const image =
    mimeType === 'image/png' ? await pdf.embedPng(source) : await pdf.embedJpg(source)
  const page = pdf.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  return pdf
}

async function loadSource(source: Buffer, mimeType: string): Promise<PDFDocument> {
  if (mimeType === 'application/pdf') {
    try {
      // Encrypted PDFs are refused rather than silently ignored: pdf-lib can
      // open some of them but cannot reliably write them back.
      return await PDFDocument.load(source, { ignoreEncryption: false })
    } catch (error) {
      throw new BadRequestError(
        'This PDF cannot be edited - it may be password protected or damaged. ' +
          'Upload an unprotected copy to place a signature on it.',
        { cause: error },
      )
    }
  }
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    return pdfFromImage(source, mimeType)
  }
  throw new UnsupportedMediaTypeError('Only a PDF, PNG or JPEG document can be signed.')
}

/**
 * Draws every placement and returns the finished PDF.
 *
 * A placement whose recorded rotation no longer matches the page's own is
 * refused rather than drawn: the coordinates describe the page as HR saw it,
 * and if the page has since been rotated they describe somewhere else. A
 * signature in the wrong place on a real document is the failure this whole
 * module exists to avoid, so it fails loudly instead.
 */
export async function stampSignature(input: StampInput): Promise<Buffer> {
  const pdf = await loadSource(input.source, input.sourceMimeType)
  const pages = pdf.getPages()

  // Embedded on first use and kept, so a document with six employee boxes
  // carries one copy of that image rather than six.
  const embedded = new Map<SignerRole, PDFImage>()
  const imageFor = async (role: SignerRole): Promise<PDFImage> => {
    const already = embedded.get(role)
    if (already) return already

    const image = input.signatures[role]
    if (!image) {
      // The service checks this before it starts, so reaching here means the
      // two disagree - which must fail rather than draw the wrong person's mark.
      throw new ConflictError(
        role === SIGNER_ROLES.AUTHORISER
          ? 'No authorising signature was supplied for this document.'
          : 'No employee signature was supplied for this document.',
      )
    }

    const drawable = await embedSignature(pdf, image.data, image.mimeType)
    embedded.set(role, drawable)
    return drawable
  }

  for (const placement of input.placements) {
    const page: PDFPage | undefined = pages[placement.pageNumber - 1]

    if (!page) {
      throw new ConflictError(
        `This document has ${pages.length} page${pages.length === 1 ? '' : 's'}, ` +
          `so a signature cannot be placed on page ${placement.pageNumber}.`,
      )
    }

    const { width, height } = page.getSize()
    const actualRotation = normalizeRotation(page.getRotation().angle)

    if (actualRotation !== placement.pageRotation) {
      throw new ConflictError(
        'This page has been rotated since the signature was positioned. ' +
          'Open the document and place the signature again.',
      )
    }

    const signature = await imageFor(placement.signerRole ?? SIGNER_ROLES.EMPLOYEE)
    const draw = toDrawParams(placement.rect, width, height, placement.pageRotation)
    page.drawImage(signature, {
      x: draw.x,
      y: draw.y,
      width: draw.width,
      height: draw.height,
      rotate: degrees(draw.rotate),
    })
  }

  return Buffer.from(await pdf.save())
}
