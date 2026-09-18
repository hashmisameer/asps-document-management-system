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
 * something is: a PROGRESSIVE JPEG, which pdf-lib cannot embed and so could
 * never be stamped or printed; an EXIF rotation, which pdf-lib does not read
 * and would draw sideways; or a file over the upload limit, which is shrunk
 * to fit rather than left behind. A re-encode is baseline, the right way up,
 * and under the limit.
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
