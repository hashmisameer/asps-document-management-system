import { describe, expect, it } from 'vitest'
import {
  fitCentred,
  imageTypeOf,
  inkBounds,
  padBounds,
  removeBackground,
  strokeWidth,
} from '../../src/lib/signatureImage.js'

/** Builds an RGBA buffer with the listed pixels opaque and everything else clear. */
function canvasOf(width: number, height: number, ink: readonly [number, number, number?][]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha] of ink) {
    data[(y * width + x) * 4 + 3] = alpha ?? 255
  }
  return data
}

describe('inkBounds', () => {
  it('returns null for a canvas nobody has drawn on', () => {
    expect(inkBounds(new Uint8ClampedArray(10 * 10 * 4), 10, 10)).toBeNull()
  })

  it('boxes the ink rather than the canvas', () => {
    // The whole point: a signature in the middle of a wide pad must not be
    // stored with the empty half of the pad around it.
    const data = canvasOf(20, 10, [
      [4, 3],
      [9, 6],
    ])
    expect(inkBounds(data, 20, 10)).toEqual({ x: 4, y: 3, width: 6, height: 4 })
  })

  it('includes a single pixel as a box of one', () => {
    expect(inkBounds(canvasOf(5, 5, [[2, 2]]), 5, 5)).toEqual({
      x: 2,
      y: 2,
      width: 1,
      height: 1,
    })
  })

  it('ignores the near-transparent fringe antialiasing leaves', () => {
    const data = canvasOf(10, 10, [
      [1, 1, 4],
      [5, 5, 255],
    ])
    expect(inkBounds(data, 10, 10)).toEqual({ x: 5, y: 5, width: 1, height: 1 })
  })
})

describe('padBounds', () => {
  it('grows the box by the margin on every side', () => {
    expect(padBounds({ x: 5, y: 5, width: 4, height: 4 }, 2, 40, 40)).toEqual({
      x: 3,
      y: 3,
      width: 8,
      height: 8,
    })
  })

  it('never leaves the canvas, however tight to the edge the ink is', () => {
    const padded = padBounds({ x: 0, y: 0, width: 4, height: 4 }, 6, 8, 8)
    expect(padded).toEqual({ x: 0, y: 0, width: 8, height: 8 })
  })
})

describe('strokeWidth', () => {
  it('scales between the two widths with pressure', () => {
    expect(strokeWidth(0, 1, 5)).toBe(3)
    expect(strokeWidth(1, 1, 5)).toBe(5)
    expect(strokeWidth(0.5, 1, 5)).toBe(3)
  })

  it('treats a device that reports no pressure as a middling one', () => {
    // A mouse reports 0.5 and an unsupported pen reports 0. Both should draw a
    // normal line rather than a hairline or nothing at all.
    expect(strokeWidth(0, 2, 6)).toBe(strokeWidth(0.5, 2, 6))
  })
})

/* -------------------------------------------------------------------------- */
/* A signature that arrives as a file                                          */
/* -------------------------------------------------------------------------- */

/** One pixel, as the four bytes canvas pixel data holds it in. */
const pixel = (r: number, g: number, b: number, a = 255): number[] => [r, g, b, a]

const pixels = (...values: number[][]): Uint8ClampedArray =>
  new Uint8ClampedArray(values.flat())

/** The alpha of every pixel, which is the only thing removeBackground changes. */
const alphas = (data: Uint8ClampedArray): number[] => {
  const out: number[] = []
  for (let i = 3; i < data.length; i += 4) out.push(data[i] ?? 0)
  return out
}

describe('what a file actually is', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

  it('knows a PNG and a JPEG by the bytes they start with', () => {
    expect(imageTypeOf(PNG)).toBe('image/png')
    expect(imageTypeOf(JPEG)).toBe('image/jpeg')
  })

  it('refuses a PDF that has been renamed to .png', () => {
    // The whole reason this reads bytes rather than the file name. A browser
    // reports the type the NAME implies, so the name proves nothing.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

    expect(imageTypeOf(pdf)).toBeNull()
  })

  it('refuses the formats that are images but not these two', () => {
    // GIF and BMP: real images, and neither is a signature the server accepts.
    expect(imageTypeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]))).toBeNull()
    expect(imageTypeOf(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('refuses a file too short to say what it is', () => {
    expect(imageTypeOf(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(imageTypeOf(new Uint8Array([]))).toBeNull()
  })
})

describe('taking the paper away', () => {
  it('makes white paper transparent and leaves dark ink alone', () => {
    const data = pixels(
      pixel(255, 255, 255), // paper
      pixel(20, 20, 20), // ink
      pixel(240, 240, 240), // slightly grey paper
    )

    expect(alphas(removeBackground(data, 200))).toEqual([0, 255, 0])
  })

  it('keeps the ink exactly as it was, colour and all', () => {
    // Only the alpha is touched: a signature in blue biro stays blue.
    const data = pixels(pixel(30, 40, 160))
    const out = removeBackground(data, 200)

    expect(Array.from(out)).toEqual([30, 40, 160, 255])
  })

  it('does not change the array it was given', () => {
    // What lets the pad run this again from the original every time the slider
    // moves. Working in place would eat the signature a notch at a time.
    const data = pixels(pixel(255, 255, 255))

    removeBackground(data, 200)

    expect(alphas(data)).toEqual([255])
  })

  it('lets the threshold decide how much counts as paper', () => {
    // The slider. A photograph in poor light needs a lower one; a page that is
    // grey rather than white needs a higher one.
    const grey = pixels(pixel(180, 180, 180))

    expect(alphas(removeBackground(grey, 200))).toEqual([255]) // kept: darker than 200
    expect(alphas(removeBackground(grey, 150))).toEqual([0]) // removed: brighter than 150
  })

  it('never makes a transparent pixel solid again', () => {
    // A PNG that already had a transparent background keeps it, whatever
    // colour its empty pixels happen to be.
    const data = pixels(pixel(0, 0, 0, 0))

    expect(alphas(removeBackground(data, 200))).toEqual([0])
  })

  it('averages the three colours rather than reading only one', () => {
    // Bright yellow paper: red and green are high, blue is not. Reading blue
    // alone would keep the whole page.
    const yellow = pixels(pixel(255, 255, 120))

    expect(alphas(removeBackground(yellow, 200))).toEqual([0])
  })
})

describe('fitting an uploaded image into the pad', () => {
  const box = { width: 900, height: 450 }

  it('scales a wide image to the width and centres it down the page', () => {
    const fitted = fitCentred({ width: 1800, height: 600 }, box)

    expect(fitted).toEqual({ x: 0, y: 75, width: 900, height: 300 })
  })

  it('scales a tall image to the height and centres it across the page', () => {
    const fitted = fitCentred({ width: 450, height: 900 }, box)

    expect(fitted).toEqual({ x: 337.5, y: 0, width: 225, height: 450 })
  })

  it('keeps the shape, so a signature is never stretched', () => {
    // A signature squashed to fill the pad is not that person's signature.
    const source = { width: 1200, height: 300 }
    const fitted = fitCentred(source, box)

    expect(fitted.width / fitted.height).toBeCloseTo(source.width / source.height)
  })

  it('fills the box exactly when the shapes already match', () => {
    expect(fitCentred({ width: 450, height: 225 }, box)).toEqual({
      x: 0,
      y: 0,
      width: 900,
      height: 450,
    })
  })

  it('gives nothing back for an image with no size', () => {
    expect(fitCentred({ width: 0, height: 0 }, box)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })
})
