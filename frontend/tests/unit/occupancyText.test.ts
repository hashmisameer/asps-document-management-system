import { describe, expect, it } from 'vitest'
import type { BoxOccupancy } from '@asps-dms/shared'
import {
  describeOccupancy,
  notEmpty,
  occupancyTitle,
} from '../../src/features/signatures/occupancyText.js'

/**
 * The warning that a box already has something in it.
 *
 * The person reading it is about to decide whether to stamp over whatever is
 * there, so the sentence has to say which box, what was found, and how much -
 * the server's numbers, not a summary of them.
 */

function box(overrides: Partial<BoxOccupancy> = {}): BoxOccupancy {
  return {
    index: 0,
    signerRole: 'Employee',
    pageNumber: 1,
    verdict: 'occupied',
    decidedBy: 'image',
    pageKind: 'digital',
    overlap: { images: 1, coverage: 0.968 },
    reason: 'an image covers 97% of the box',
    ...overrides,
  }
}

describe('describeOccupancy', () => {
  it('names the box by its signer and page', () => {
    expect(describeOccupancy(box()).where).toBe('Employee signature box on page 1')
    expect(
      describeOccupancy(box({ signerRole: 'Authoriser', pageNumber: 2 })).where,
    ).toBe('HR signature box on page 2')
    expect(describeOccupancy(box({ signerRole: 'Photo' })).where).toBe('Employee photo box on page 1')
  })

  it('says how much of the box one image covers', () => {
    expect(describeOccupancy(box()).because).toBe('an image covers 97% of it')
  })

  it('counts the images when more than one touches the box', () => {
    const line = describeOccupancy(box({ overlap: { images: 3, coverage: 0.4 } }))
    expect(line.because).toBe('3 images are on it, one covering 40%')
  })

  it('gives the ink measurement to a tenth of a percent', () => {
    const line = describeOccupancy(
      box({
        decidedBy: 'ink',
        pageKind: 'scanned',
        overlap: { images: 0, coverage: 0 },
        ink: { percent: 6.123, background: 231, cutoff: 191 },
      }),
    )
    expect(line.verdict).toBe('Already has something in it')
    expect(line.because).toBe(
      "6.1% of it is ink, measured against the page's own background",
    )
  })

  it('says it could not tell, and why, for an uncertain box', () => {
    const line = describeOccupancy(
      box({
        verdict: 'uncertain',
        decidedBy: 'none',
        overlap: { images: 0, coverage: 0 },
        reason: 'the document has no page 3',
        pageNumber: 3,
      }),
    )
    expect(line.verdict).toBe('Could not tell')
    expect(line.because).toBe('the document has no page 3')
  })
})

describe('occupancyTitle', () => {
  it('speaks of one box, or counts them', () => {
    expect(occupancyTitle([box()])).toBe('That box already has something in it')
    expect(occupancyTitle([box(), box({ index: 1 })])).toBe(
      '2 of the boxes already have something in them',
    )
  })

  it('is honest about uncertainty', () => {
    expect(occupancyTitle([box({ verdict: 'uncertain' })])).toBe(
      'It is not clear whether that box is empty',
    )
    expect(occupancyTitle([box({ verdict: 'uncertain' }), box({ verdict: 'uncertain' })])).toBe(
      'It is not clear whether 2 of the boxes are empty',
    )
    expect(occupancyTitle([box(), box({ verdict: 'uncertain' })])).toBe(
      '1 of the boxes already have something in them, and 1 may',
    )
  })
})

describe('notEmpty', () => {
  it('keeps only the boxes worth a warning', () => {
    const kept = notEmpty([
      box({ index: 0, verdict: 'empty', decidedBy: 'none' }),
      box({ index: 1 }),
      box({ index: 2, verdict: 'uncertain' }),
    ])
    expect(kept.map((item) => item.index)).toEqual([1, 2])
  })
})
