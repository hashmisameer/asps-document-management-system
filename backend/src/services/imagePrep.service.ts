import sharp from 'sharp'
import { MAX_SIGNATURE_SIZE_BYTES } from '@asps-dms/shared'

/**
 * A photograph or signature image as pdf-lib can use it.
 *
 * One place, because four paths need the same answer: a photograph uploaded
 * by hand, a signature uploaded by hand, the files MMC already holds, and a
 * photograph read back from the store at stamp time. A second copy of this
 * rule is how a JPEG that one path fixes and another does not turns up as a
 * 415 on the signing screen with the document apparently at fault.
 *
 * Its own module rather than a corner of mmcImages.service: that module
 * reaches signature.service, which needs this too, and a static cycle is a
 * thing to avoid even where the runtime would tolerate it.
 */

/** The longest side a photograph is kept at when it has to be shrunk to fit. */
const PHOTO_MAX_PX = 1600

export interface PreparedImage {
  buffer: Buffer
  /** Whether the source was a progressive JPEG - the reason most re-encodes happen. */
  progressive: boolean
  /** Whether `buffer` differs from the source at all. */
  converted: boolean
}

/**
 * A JPEG photograph as the DMS can use it.
 *
 * Left byte for byte as it was when nothing is wrong with it. Re-encoded when
 * something is: an EXIF rotation, which pdf-lib does not read and would draw
 * sideways; a file over the upload limit, which is shrunk to fit rather than
 * left behind; or a PROGRESSIVE JPEG. A re-encode is baseline, the right way
 * up, and under the limit.
 *
 * WHY PROGRESSIVE IS RE-ENCODED - not the reason this used to give. pdf-lib
 * DOES embed a progressive JPEG: checked against pdf-lib 1.17.1, which embeds,
 * draws, saves and reloads one without complaint. What a7ce029 recorded was a
 * real photograph pdf-lib refused with a 415, blamed on its being progressive;
 * what was actually wrong with that file was not kept. The re-encode stays
 * because it is what fixed it: every JPEG that reaches pdf-lib is then one
 * sharp has decoded and written fresh as plain baseline, whatever oddity the
 * original carried. Progressive is the cheap signal that a file came from
 * somewhere other than an ordinary camera or scanner, not the fault itself.
 */
export async function preparePhoto(source: Buffer): Promise<PreparedImage> {
  const meta = await sharp(source, { failOn: 'error' }).metadata()
  const progressive = meta.isProgressive === true
  const rotated = (meta.orientation ?? 1) !== 1
  const tooLarge = source.byteLength > MAX_SIGNATURE_SIZE_BYTES

  if (!progressive && !rotated && !tooLarge) {
    return { buffer: source, progressive, converted: false }
  }

  let pipeline = sharp(source, { failOn: 'error' }).rotate()
  if (tooLarge) {
    pipeline = pipeline.resize({
      width: PHOTO_MAX_PX,
      height: PHOTO_MAX_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  const buffer = await pipeline.jpeg({ progressive: false, quality: tooLarge ? 85 : 90 }).toBuffer()
  return { buffer, progressive, converted: true }
}

/**
 * Whatever image arrived, in a form pdf-lib will embed.
 *
 * A JPEG goes through preparePhoto. A PNG is returned as it is: pdf-lib reads
 * PNGs itself, the upload check has already proved it decodes, and sharp
 * reports an interlaced PNG as 'progressive' too - re-encoding one of those
 * into a JPEG under a .png name would be the wrong fix for a problem it does
 * not have.
 */
export async function prepareForPdf(source: Buffer, mimeType: string): Promise<PreparedImage> {
  if (mimeType !== 'image/jpeg') return { buffer: source, progressive: false, converted: false }
  return preparePhoto(source)
}

/** A document image as the stamper draws it. */
export interface UprightImage {
  buffer: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  /** Its size the right way up, in pixels. */
  widthPx: number
  heightPx: number
}

/**
 * A DOCUMENT that is a picture - a phone photo or scan of an Aadhaar or PAN
 * card - the right way up, in a form pdf-lib embeds.
 *
 * THE RIGHT WAY UP BY THE SAME RULE EVERYWHERE: sharp's rotate(), which reads
 * the EXIF orientation. It is what the browser shows HR in the editor, what
 * the occupancy check measures (toGrey with orient), and what preparePhoto
 * does to a photograph. Without it the stamper drew the raw pixels, which on a
 * phone photo are usually on their side, so a box placed where HR saw it
 * landed somewhere else on the signed copy, with no error.
 *
 * A JPEG or PNG that is already upright and unremarkable is passed through
 * untouched - no second round of JPEG loss. A rotated or progressive JPEG is
 * re-encoded baseline (see preparePhoto). WebP and TIFF, which the upload
 * accepts and pdf-lib does not read, become PNG; a multi-page TIFF is read
 * from its first page, as the identity check reads it.
 */
export async function uprightDocumentImage(source: Buffer, mimeType: string): Promise<UprightImage> {
  const meta = await sharp(source, { failOn: 'error' }).metadata()
  const rotated = (meta.orientation ?? 1) !== 1
  const upright = (width: number, height: number) =>
    (meta.orientation ?? 1) >= 5 ? { widthPx: height, heightPx: width } : { widthPx: width, heightPx: height }
  const size = upright(meta.width ?? 0, meta.height ?? 0)

  if (mimeType === 'image/jpeg') {
    if (!rotated && meta.isProgressive !== true) return { buffer: source, mimeType, ...size }
    const buffer = await sharp(source, { failOn: 'error' })
      .rotate()
      .jpeg({ progressive: false, quality: 92 })
      .toBuffer()
    return { buffer, mimeType: 'image/jpeg', ...size }
  }
  if (mimeType === 'image/png' && !rotated) return { buffer: source, mimeType, ...size }

  const buffer = await sharp(source, { failOn: 'error' }).rotate().png().toBuffer()
  return { buffer, mimeType: 'image/png', ...size }
}
