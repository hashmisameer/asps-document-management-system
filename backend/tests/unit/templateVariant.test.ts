import { describe, expect, it } from 'vitest'
import {
  SHAPE_TOLERANCE,
  exactVariantKey,
  findVariant,
  paperSizeLabel,
  sameShape,
  shapeOf,
  toVariant,
  variantKey,
  variantLabel,
  variantMatches,
} from '@asps-dms/shared'

/**
 * Which form a PDF is, and whether an upload is that form.
 *
 * The rule the stamper lives by: page count exactly, the page the same SHAPE
 * - same way up, proportions within one per cent - and never the nearest
 * when none or more than one matches. Size does not come into it: the
 * office's forms come out at twenty sizes for one document, all A4-shaped.
 */

const PF_TWO_PAGE = { pageCount: 2, widthPt: 595, heightPt: 842 }
const FORM_11 = { pageCount: 1, widthPt: 595, heightPt: 842 }
const LETTER = { pageCount: 1, widthPt: 612, heightPt: 792 }

describe('a variant', () => {
  it('records the sample it was drawn on, rounded to whole points', () => {
    expect(toVariant(2, 595.28, 841.89)).toEqual(PF_TWO_PAGE)
  })

  it('has a shape: pages, which way up, and proportion', () => {
    expect(shapeOf(FORM_11)).toEqual({ pageCount: 1, orientation: 'portrait', aspect: 842 / 595 })
    expect(shapeOf({ pageCount: 1, widthPt: 842, heightPt: 595 }).orientation).toBe('landscape')
    expect(shapeOf({ pageCount: 1, widthPt: 500, heightPt: 510 }).orientation).toBe('square')
  })

  it('is named by its paper and its pages, whatever its exact size', () => {
    expect(variantLabel(PF_TWO_PAGE)).toBe('A4 portrait, 2 pages')
    expect(variantLabel({ pageCount: 2, widthPt: 596, heightPt: 841 })).toBe('A4 portrait, 2 pages')
    expect(variantLabel({ pageCount: 1, widthPt: 842, heightPt: 595 })).toBe('A4 landscape, 1 page')
    expect(variantLabel(LETTER)).toBe('Letter portrait, 1 page')
    expect(variantLabel({ pageCount: 3, widthPt: 400, heightPt: 700 })).toBe(
      'portrait, 1.75 to 1, 3 pages',
    )
    expect(paperSizeLabel(612, 1008)).toBe('Legal portrait')
    expect(paperSizeLabel(500, 510)).toBe('square')
  })

  it('keys by shape for grouping - and the key is not what matching uses', () => {
    expect(variantKey(FORM_11)).toBe('1p-portrait-1.42')
    expect(variantKey({ pageCount: 1, widthPt: 596, heightPt: 842 })).toBe('1p-portrait-1.41')
    // Different keys, one shape: the key rounds, the match does not.
    expect(
      sameShape(shapeOf(FORM_11), shapeOf({ pageCount: 1, widthPt: 596, heightPt: 842 })),
    ).toBe(true)
  })

  it('has an exact key that tells two saved templates of one shape apart', () => {
    // The stamper collects a template's boxes by this, never by the shape key:
    // 595x841 and 596x842 are one shape and two saves.
    expect(exactVariantKey(FORM_11)).toBe('1p-595x842')
    expect(exactVariantKey({ pageCount: 1, widthPt: 595, heightPt: 841 })).toBe('1p-595x841')
    expect(exactVariantKey({ pageCount: 1, widthPt: 596, heightPt: 842 })).toBe('1p-596x842')
    expect(exactVariantKey({ pageCount: 2, widthPt: 595, heightPt: 842 })).toBe('2p-595x842')
  })
})

describe('matching an upload to a variant', () => {
  it('takes every A4-shaped page as one form, whatever its point size', () => {
    const sizes: [number, number][] = [
      [595, 842],
      [595, 841],
      [596, 842],
      [595.28, 841.89],
      [612, 866],
      [1190, 1684],
    ]
    for (const [widthPt, heightPt] of sizes) {
      expect(variantMatches(FORM_11, { pageCount: 1, widthPt, heightPt })).toBe(true)
    }
  })

  it('needs the page count exactly, however alike the first page is', () => {
    expect(variantMatches(PF_TWO_PAGE, { pageCount: 1, widthPt: 595, heightPt: 842 })).toBe(false)
    expect(variantMatches(FORM_11, { pageCount: 2, widthPt: 595, heightPt: 842 })).toBe(false)
  })

  it('tells A4 from Letter: a box in the wrong place is worse than signing by hand', () => {
    expect(variantMatches(FORM_11, LETTER)).toBe(false)
    expect(variantMatches(LETTER, FORM_11)).toBe(false)
    expect(variantMatches(FORM_11, { pageCount: 1, widthPt: 612, heightPt: 1008 })).toBe(false)
  })

  it('never matches a page the other way up', () => {
    expect(variantMatches(FORM_11, { pageCount: 1, widthPt: 842, heightPt: 595 })).toBe(false)
  })

  it('draws the line at one per cent of the proportion', () => {
    expect(SHAPE_TOLERANCE).toBe(0.01)
    const a4 = 842 / 595
    // Just inside, and just outside, one per cent either way.
    const inside = { pageCount: 1, widthPt: 1000, heightPt: 1000 * a4 * 1.009 }
    const outside = { pageCount: 1, widthPt: 1000, heightPt: 1000 * a4 * 1.011 }
    expect(variantMatches(FORM_11, inside)).toBe(true)
    expect(variantMatches(FORM_11, outside)).toBe(false)
  })

  it('picks the one form that matches, and nothing when none does', () => {
    const variants = [PF_TWO_PAGE, FORM_11]
    expect(findVariant(variants, { pageCount: 1, widthPt: 596, heightPt: 841 })).toBe(FORM_11)
    expect(findVariant(variants, { pageCount: 2, widthPt: 595.28, heightPt: 841.89 })).toBe(
      PF_TWO_PAGE,
    )
    // A scan at a shape no template has. Not stamped, never guessed at.
    expect(findVariant(variants, { pageCount: 1, widthPt: 620, heightPt: 930 })).toBeNull()
    expect(findVariant(variants, { pageCount: 3, widthPt: 595, heightPt: 842 })).toBeNull()
    expect(findVariant([], { pageCount: 1, widthPt: 595, heightPt: 842 })).toBeNull()
  })

  it('refuses to choose when two saved variants are one shape', () => {
    // Two templates saved under the old exact-size key, both A4: the document
    // is neither until an administrator saves once, which replaces both.
    const near = { pageCount: 1, widthPt: 596, heightPt: 843 }
    expect(
      findVariant([FORM_11, near], { pageCount: 1, widthPt: 595.5, heightPt: 842.5 }),
    ).toBeNull()
  })
})
