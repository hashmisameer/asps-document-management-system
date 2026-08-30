import { describe, expect, it } from 'vitest'
import {
  clampToPage,
  displayedPageSize,
  fromPdfUserSpace,
  fromRenderedRect,
  intersectionOverUnion,
  normalizeRotation,
  toPdfUserSpace,
  toRenderedRect,
  type NormalizedRect,
  type PageRotation,
} from '@asps-dms/shared'

/**
 * The signature coordinate system is the single most failure-prone part of this
 * application: a subtle error here places a signature in the wrong spot on a
 * real employee document, and it would not be obvious from the editor preview.
 *
 * These tests pin the behaviour in absolute terms (a known corner lands on a
 * known corner) as well as by round-trip, because a round-trip alone would
 * happily confirm a transform that is self-consistent but wrong.
 */

const A4 = { width: 595.28, height: 841.89 }
const LETTER = { width: 612, height: 792 }
const LEGAL = { width: 612, height: 1008 }

describe('normalizeRotation', () => {
  it('normalises the values a real PDF /Rotate entry can hold', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(-270)).toBe(90)
  })
})

describe('displayedPageSize', () => {
  it('swaps the axes at 90 and 270 degrees', () => {
    expect(displayedPageSize(600, 800, 0)).toEqual({ width: 600, height: 800 })
    expect(displayedPageSize(600, 800, 180)).toEqual({ width: 600, height: 800 })
    expect(displayedPageSize(600, 800, 90)).toEqual({ width: 800, height: 600 })
    expect(displayedPageSize(600, 800, 270)).toEqual({ width: 800, height: 600 })
  })
})

describe('editor pixels <-> normalized', () => {
  it('is independent of zoom level and raster scale', () => {
    const rendered100 = { width: 800, height: 1000 }
    const rendered150 = { width: 1200, height: 1500 }

    const normalized = fromRenderedRect({ x: 200, y: 300, width: 100, height: 50 }, rendered100)

    // The same normalized rect must land proportionally at 150% zoom.
    expect(toRenderedRect(normalized, rendered150)).toEqual({
      x: 300,
      y: 450,
      width: 150,
      height: 75,
    })
  })

  it('rejects a zero-sized render box rather than dividing by zero', () => {
    expect(() => fromRenderedRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 10 })).toThrow(
      RangeError,
    )
  })
})

describe('toPdfUserSpace - absolute corner mapping', () => {
  // A 10% square anchored at the DISPLAYED top-left corner. Where it lands in
  // unrotated PDF user space is fully determined by the page rotation.
  const topLeft: NormalizedRect = { x: 0, y: 0, width: 0.1, height: 0.1 }
  const W = 600
  const H = 800

  it('0 degrees: displayed top-left -> PDF top-left', () => {
    // PDF y counts up from the bottom, so the top edge is y = H.
    expect(toPdfUserSpace(topLeft, W, H, 0)).toEqual({ x: 0, y: 720, width: 60, height: 80 })
  })

  it('90 degrees: displayed top-left -> PDF bottom-left', () => {
    // Rotating the page 90 clockwise brings its bottom-left corner to the top-left.
    expect(toPdfUserSpace(topLeft, W, H, 90)).toEqual({ x: 0, y: 0, width: 60, height: 80 })
  })

  it('180 degrees: displayed top-left -> PDF bottom-right', () => {
    expect(toPdfUserSpace(topLeft, W, H, 180)).toEqual({ x: 540, y: 0, width: 60, height: 80 })
  })

  it('270 degrees: displayed top-left -> PDF top-right', () => {
    expect(toPdfUserSpace(topLeft, W, H, 270)).toEqual({ x: 540, y: 720, width: 60, height: 80 })
  })

  it('keeps a placement inside the page bounds for every rotation', () => {
    const bottomRight: NormalizedRect = { x: 0.85, y: 0.9, width: 0.15, height: 0.1 }
    for (const rotation of [0, 90, 180, 270] as PageRotation[]) {
      const rect = toPdfUserSpace(bottomRight, W, H, rotation)
      expect(rect.x).toBeGreaterThanOrEqual(-0.001)
      expect(rect.y).toBeGreaterThanOrEqual(-0.001)
      expect(rect.x + rect.width).toBeLessThanOrEqual(W + 0.001)
      expect(rect.y + rect.height).toBeLessThanOrEqual(H + 0.001)
    }
  })

  it('rejects a non-positive page size', () => {
    expect(() => toPdfUserSpace(topLeft, 0, 800, 0)).toThrow(RangeError)
    expect(() => toPdfUserSpace(topLeft, 600, -1, 0)).toThrow(RangeError)
  })
})

describe('toPdfUserSpace <-> fromPdfUserSpace round trip', () => {
  const pages = [A4, LETTER, LEGAL, { width: 800, height: 600 }]
  const rotations: PageRotation[] = [0, 90, 180, 270]
  const rects: NormalizedRect[] = [
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
    { x: 0.72, y: 0.88, width: 0.25, height: 0.1 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ]

  it('returns the original rect for every page size and rotation', () => {
    for (const page of pages) {
      for (const rotation of rotations) {
        for (const rect of rects) {
          const pdfRect = toPdfUserSpace(rect, page.width, page.height, rotation)
          const back = fromPdfUserSpace(pdfRect, page.width, page.height, rotation)

          expect(back.x).toBeCloseTo(rect.x, 9)
          expect(back.y).toBeCloseTo(rect.y, 9)
          expect(back.width).toBeCloseTo(rect.width, 9)
          expect(back.height).toBeCloseTo(rect.height, 9)
        }
      }
    }
  })
})

describe('clampToPage', () => {
  it('pulls an over-dragged placement back inside the page', () => {
    expect(clampToPage({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 })).toEqual({
      x: 0.8,
      y: 0.8,
      width: 0.2,
      height: 0.2,
    })
  })

  it('refuses to shrink a placement into invisibility', () => {
    const result = clampToPage({ x: 0.5, y: 0.5, width: 0.0001, height: 0.0001 })
    expect(result.width).toBeGreaterThanOrEqual(0.01)
    expect(result.height).toBeGreaterThanOrEqual(0.01)
  })

  it('handles negative coordinates from a drag past the top-left edge', () => {
    expect(clampToPage({ x: -0.3, y: -0.1, width: 0.2, height: 0.2 })).toEqual({
      x: 0,
      y: 0,
      width: 0.2,
      height: 0.2,
    })
  })
})

describe('intersectionOverUnion', () => {
  it('is 1 for identical rects and 0 for disjoint ones', () => {
    const a: NormalizedRect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    expect(intersectionOverUnion(a, a)).toBeCloseTo(1, 9)
    expect(intersectionOverUnion(a, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })).toBe(0)
  })

  it('scores a partial overlap between 0 and 1', () => {
    const a: NormalizedRect = { x: 0, y: 0, width: 0.2, height: 0.2 }
    const b: NormalizedRect = { x: 0.1, y: 0, width: 0.2, height: 0.2 }
    const iou = intersectionOverUnion(a, b)
    expect(iou).toBeGreaterThan(0)
    expect(iou).toBeLessThan(1)
    // intersection 0.1*0.2=0.02, union 0.04+0.04-0.02=0.06
    expect(iou).toBeCloseTo(1 / 3, 9)
  })
})
