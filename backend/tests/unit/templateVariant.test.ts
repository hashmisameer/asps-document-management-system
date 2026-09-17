import { describe, expect, it } from 'vitest'
import {
  VARIANT_SIZE_SLACK_PT,
  findVariant,
  paperSizeLabel,
  toVariant,
  variantKey,
  variantLabel,
  variantMatches,
} from '@asps-dms/shared'

/**
 * Which form a PDF is, and whether an upload is that form.
 *
 * The rule the stamper will live by: page count exactly, page size within two
 * points, and never the nearest when none or more than one matches.
 */

const PF_TWO_PAGE = { pageCount: 2, widthPt: 595, heightPt: 842 }
const FORM_11 = { pageCount: 1, widthPt: 595, heightPt: 842 }

describe('a variant', () => {
  it('is the page count and the first page rounded to whole points', () => {
    expect(toVariant(2, 595.28, 841.89)).toEqual(PF_TWO_PAGE)
    // A re-save that moved the page by a fraction is the same form.
    expect(variantKey(toVariant(2, 595.4, 841.6))).toBe(variantKey(PF_TWO_PAGE))
  })

  it('is named by its pages and its paper', () => {
    expect(variantLabel(PF_TWO_PAGE)).toBe('2-page form (A4 portrait)')
    expect(variantLabel({ pageCount: 1, widthPt: 842, heightPt: 595 })).toBe('1-page form (A4 landscape)')
    expect(variantLabel({ pageCount: 3, widthPt: 400, heightPt: 700 })).toBe('3-page form (400 x 700 pt)')
    expect(paperSizeLabel(612, 792)).toBe('Letter portrait')
  })
})

describe('matching an upload to a variant', () => {
  it('needs the page count exactly, and the size within the slack', () => {
    expect(variantMatches(PF_TWO_PAGE, { pageCount: 2, widthPt: 595.28, heightPt: 841.89 })).toBe(true)
    expect(variantMatches(PF_TWO_PAGE, { pageCount: 2, widthPt: 597, heightPt: 840 })).toBe(true)
    expect(variantMatches(PF_TWO_PAGE, { pageCount: 2, widthPt: 598.5, heightPt: 842 })).toBe(false)
    // One page and two pages are different papers however alike the first page is.
    expect(variantMatches(PF_TWO_PAGE, { pageCount: 1, widthPt: 595, heightPt: 842 })).toBe(false)
    expect(VARIANT_SIZE_SLACK_PT).toBe(2)
  })

  it('tells A4 from Letter', () => {
    expect(variantMatches(FORM_11, { pageCount: 1, widthPt: 612, heightPt: 792 })).toBe(false)
  })

  it('picks the one form that matches, and nothing when none does', () => {
    const variants = [PF_TWO_PAGE, FORM_11]
    expect(findVariant(variants, { pageCount: 1, widthPt: 595.28, heightPt: 841.89 })).toBe(FORM_11)
    expect(findVariant(variants, { pageCount: 2, widthPt: 595.28, heightPt: 841.89 })).toBe(PF_TWO_PAGE)
    // A scan: one page, the scanner's size. Not stamped, never guessed at.
    expect(findVariant(variants, { pageCount: 1, widthPt: 620, heightPt: 877 })).toBeNull()
    expect(findVariant(variants, { pageCount: 3, widthPt: 595, heightPt: 842 })).toBeNull()
    expect(findVariant([], { pageCount: 1, widthPt: 595, heightPt: 842 })).toBeNull()
  })

  it('refuses to choose when two variants both claim a document', () => {
    // Two templates within the slack of each other: the document is neither.
    const near = { pageCount: 1, widthPt: 596, heightPt: 843 }
    expect(findVariant([FORM_11, near], { pageCount: 1, widthPt: 595.5, heightPt: 842.5 })).toBeNull()
  })
})
