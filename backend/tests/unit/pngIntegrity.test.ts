import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  MalformedImageError,
  assertDecodablePng,
} from '../../src/services/pngIntegrity.service.js'

/**
 * Proving a PNG is whole before a decoder is asked to read it.
 *
 * This guards a real outage, not a hypothetical one: pdf-lib loops for ever on
 * a PNG whose image data ends early, on the single thread that serves every
 * request, so one malformed upload takes the whole API down. The case that did
 * it is pinned below by its actual bytes.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function ihdr(width: number, height: number, bitDepth = 8, colourType = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = bitDepth
  data[9] = colourType
  data[12] = interlace
  return chunk('IHDR', data)
}

/** A whole, decodable PNG: every scanline present, correctly compressed. */
function wholePng(width = 8, height = 4): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4))
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('assertDecodablePng', () => {
  it('accepts a whole PNG', () => {
    expect(() => assertDecodablePng(wholePng())).not.toThrow()
  })

  it('accepts a PNG that pdf-lib can actually embed', async () => {
    // The point of the check is to agree with the decoder it protects, so the
    // same buffer is put through pdf-lib here.
    const png = wholePng(16, 8)
    assertDecodablePng(png)
    const document = await PDFDocument.create()
    const embedded = await document.embedPng(png)
    expect(embedded.width).toBe(16)
    expect(embedded.height).toBe(8)
  })

  it('refuses the upload that took the API down', () => {
    // 137 bytes declaring a 100x40 image, carrying 79 bytes of damaged zlib and
    // a trailing chunk claiming 3.3 GB. pdf-lib blocks the event loop on this.
    const wedged = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAoCAYAAAAOWXOWAAAAT0lEQVR4nO3PMQ0AAAgDsOHf9F0hCSRt' +
        'cbTJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkuQCB9' +
        'YAAWs0z8kAAAAASUVORK5CYII=',
      'base64',
    )
    expect(() => assertDecodablePng(wedged)).toThrow(MalformedImageError)
  })

  it('refuses a PNG whose image data stops early', () => {
    // The failure that matters: structurally valid, but short by one scanline,
    // which is precisely what the decoder waits for and never receives.
    const width = 8
    const height = 4
    const short = Buffer.alloc((height - 1) * (1 + width * 4))
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height),
      chunk('IDAT', zlib.deflateSync(short)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => assertDecodablePng(png)).toThrow(/incomplete/i)
  })

  it('refuses a chunk that claims more bytes than the file holds', () => {
    const png = wholePng()
    // A length field far beyond the buffer: what a truncated upload looks like.
    png.writeUInt32BE(0xfffffff0, PNG_SIGNATURE.length)
    expect(() => assertDecodablePng(png)).toThrow(MalformedImageError)
  })

  it('refuses damaged compressed data', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(8, 4),
      chunk('IDAT', Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03, 0x04])),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => assertDecodablePng(png)).toThrow(/damaged/i)
  })

  it('refuses a file with no end marker', () => {
    const png = Buffer.concat([PNG_SIGNATURE, ihdr(8, 4), chunk('IDAT', zlib.deflateSync(Buffer.alloc(4 * 33)))])
    expect(() => assertDecodablePng(png)).toThrow(/truncated/i)
  })

  it('refuses a file that is not a PNG at all', () => {
    expect(() => assertDecodablePng(Buffer.from('not an image at all, really'))).toThrow(
      MalformedImageError,
    )
  })

  it('refuses a header declaring an enormous image', () => {
    // A few hundred bytes can claim a gigapixel frame; the raw size is computed
    // from these numbers, so they are checked before it is.
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(60_000, 60_000),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => assertDecodablePng(png)).toThrow(/too large/i)
  })

  it('refuses a decompression bomb rather than expanding it', () => {
    // 4 MB of zeroes compresses to a few KB. The ceiling is what the header
    // itself asks for, so a stream that keeps going is stopped.
    const bomb = zlib.deflateSync(Buffer.alloc(4 * 1024 * 1024))
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(8, 4),
      chunk('IDAT', bomb),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => assertDecodablePng(png)).toThrow(MalformedImageError)
  })

  it('accepts an interlaced PNG, whose raw length is the sum of seven passes', () => {
    const width = 16
    const height = 16
    const passes = [
      [2, 2], [2, 2], [4, 2], [4, 4], [8, 4], [8, 8], [16, 8],
    ]
    const total = passes.reduce((sum, [w, h]) => sum + (h as number) * (1 + (w as number) * 4), 0)
    const png = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height, 8, 6, 1),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(total))),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => assertDecodablePng(png)).not.toThrow()
  })
})
