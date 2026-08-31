import { describe, expect, it } from 'vitest'
import { inkBounds, padBounds, strokeWidth } from '../../src/lib/signatureImage.js'

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
