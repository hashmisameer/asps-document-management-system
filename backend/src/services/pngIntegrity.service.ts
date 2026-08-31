import zlib from 'node:zlib'

/**
 * Proving a PNG is whole before anything tries to decode it.
 *
 * This exists because of a real failure, not a hypothetical one. pdf-lib
 * decodes a PNG's pixels to embed it, and given a file whose IDAT stream ends
 * early it loops waiting for scanlines that never arrive. Node runs that loop
 * on the single thread that serves every request, so ONE malformed signature
 * upload stops the whole API - not just that request, and not just that user.
 * There is no timeout that helps: a synchronous loop cannot be interrupted from
 * the thread it is blocking.
 *
 * So the file is checked here, where a bad one is a 400, rather than trusted to
 * a decoder that has no way to say no.
 *
 * Everything below reads structure only, in bounded loops, and hands the one
 * unbounded job - inflating the pixel stream - to node's zlib, which is native,
 * throws on bad input and does not hang. A file that survives this has a whole
 * pixel stream of exactly the length its own header promises, which is the
 * thing pdf-lib assumes and does not verify.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel for each PNG colour type. Anything else is not a PNG. */
const CHANNELS: Readonly<Record<number, number>> = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // indexed
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
}

const VALID_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

/**
 * A ceiling on the pixel buffer a file may ask us to account for.
 *
 * A 40 MP image is far beyond any signature, and the point is to refuse a
 * header claiming enormous dimensions before its raw size is computed from
 * them - a small file can declare a very large image.
 */
const MAX_PIXELS = 40_000_000

export class MalformedImageError extends Error {}

interface Header {
  width: number
  height: number
  bitDepth: number
  colourType: number
  interlace: number
}

/**
 * The expected size of the decompressed pixel stream.
 *
 * Each scanline is one filter byte followed by its pixels, and a sub-byte depth
 * packs pixels into whole bytes with the row rounded up. This is the number a
 * truncated file fails to produce, and the whole reason for computing it.
 */
function rawLength(header: Header): number {
  const channels = CHANNELS[header.colourType] as number
  const bitsPerPixel = channels * header.bitDepth
  const rowBytes = Math.ceil((bitsPerPixel * header.width) / 8)
  return header.height * (rowBytes + 1)
}

/**
 * Adam7 stores seven smaller images, so an interlaced file's raw length is the
 * sum of those passes rather than one full-size frame.
 */
const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
]

function interlacedRawLength(header: Header): number {
  const channels = CHANNELS[header.colourType] as number
  const bitsPerPixel = channels * header.bitDepth
  let total = 0
  for (const pass of ADAM7) {
    const width = Math.ceil((header.width - pass.xStart) / pass.xStep)
    const height = Math.ceil((header.height - pass.yStart) / pass.yStep)
    if (width <= 0 || height <= 0) continue
    total += height * (Math.ceil((bitsPerPixel * width) / 8) + 1)
  }
  return total
}

/**
 * Reads the chunk structure, returning the header and the joined pixel stream.
 *
 * Every length is checked against what is actually left in the buffer before it
 * is used, so a chunk header claiming more bytes than the file holds - which is
 * exactly what a truncated upload looks like - ends the walk instead of
 * addressing memory that was never sent.
 */
function readChunks(buffer: Buffer): { header: Header; idat: Buffer } {
  if (buffer.byteLength < PNG_SIGNATURE.length + 12) {
    throw new MalformedImageError('The file is too short to be a PNG.')
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new MalformedImageError('The file does not begin with a PNG signature.')
  }

  let offset = PNG_SIGNATURE.length
  let header: Header | null = null
  let sawEnd = false
  const idat: Buffer[] = []

  // Every pass consumes at least 12 bytes, so this cannot spin.
  while (offset + 8 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length

    // The CRC has to be there too, which is why this is + 4.
    if (length > buffer.byteLength || dataEnd + 4 > buffer.byteLength) {
      // The type is four bytes of the file, so it is only quoted back when it
      // reads as a real chunk name. On a damaged file it is arbitrary binary,
      // and putting that in a message shown to someone is how control
      // characters end up on a screen or in a log line.
      const named = /^[A-Za-z]{4}$/.test(type) ? `${type} section` : 'file'
      throw new MalformedImageError(`The PNG's ${named} is cut short.`)
    }

    if (type === 'IHDR') {
      if (length !== 13) throw new MalformedImageError("The PNG's header is the wrong size.")
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8] as number,
        colourType: buffer[dataStart + 9] as number,
        interlace: buffer[dataStart + 12] as number,
      }
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }

    offset = dataEnd + 4
  }

  if (!header) throw new MalformedImageError('The PNG has no header.')
  if (!sawEnd) throw new MalformedImageError('The PNG has no end marker; it looks truncated.')
  if (idat.length === 0) throw new MalformedImageError('The PNG carries no image data.')

  return { header, idat: Buffer.concat(idat) }
}

/**
 * Throws unless this buffer is a PNG that can be decoded to completion.
 *
 * Called before pdf-lib sees the file. The message is written for whoever is
 * looking at an upload form: what they can do about it is re-export or re-scan
 * the image, so that is what it says.
 */
export function assertDecodablePng(buffer: Buffer): void {
  const { header, idat } = readChunks(buffer)

  if (header.width === 0 || header.height === 0) {
    throw new MalformedImageError('The PNG declares an empty image.')
  }
  if (header.width * header.height > MAX_PIXELS) {
    throw new MalformedImageError('That image is too large to process.')
  }
  if (!(header.colourType in CHANNELS)) {
    throw new MalformedImageError('The PNG uses an unknown colour type.')
  }
  if (!VALID_BIT_DEPTHS[header.colourType]?.includes(header.bitDepth)) {
    throw new MalformedImageError('The PNG uses an unsupported bit depth.')
  }
  if (header.interlace !== 0 && header.interlace !== 1) {
    throw new MalformedImageError('The PNG uses an unknown interlace method.')
  }

  const expected = header.interlace === 1 ? interlacedRawLength(header) : rawLength(header)

  let inflated: Buffer
  try {
    // maxOutputLength stops a decompression bomb: a few KB of zlib can expand
    // to gigabytes, and the ceiling is what this file itself says it needs.
    inflated = zlib.inflateSync(idat, { maxOutputLength: expected + 1 })
  } catch {
    throw new MalformedImageError("The PNG's image data is damaged and could not be read.")
  }

  // The decisive check. pdf-lib assumes this and loops for ever when it does
  // not hold, so a file that is short here must never reach it.
  if (inflated.byteLength !== expected) {
    throw new MalformedImageError('The PNG is incomplete; some of the image is missing.')
  }
}
