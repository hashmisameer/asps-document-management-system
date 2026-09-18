import { describe, expect, it } from 'vitest'
import { groupByShape } from '../../src/services/templateShapes.service.js'

/**
 * Grouping a type's documents by shape: what one template covers.
 *
 * The office's Appointment Letters came out at twenty sizes, all A4-shaped.
 * Grouped to one per cent they are one shape, and the editor can say so:
 * one template, 98% of the letters. Letter-sized ones are their own group.
 */

const measured = [
  ...[595, 595, 596, 595, 594].map((w, i) => ({
    documentId: 100 + i,
    variant: { pageCount: 1, widthPt: w, heightPt: 842 - (i % 2) },
  })),
  { documentId: 200, variant: { pageCount: 1, widthPt: 612, heightPt: 792 } },
  { documentId: 300, variant: { pageCount: 2, widthPt: 595, heightPt: 842 } },
]

describe('groupByShape', () => {
  it('folds every A4-shaped size into one group, and keeps Letter and the two-page form apart', () => {
    const groups = groupByShape(measured, [], measured.length)

    expect(groups.map((g) => [g.label, g.documents])).toEqual([
      ['A4 portrait, 1 page', 5],
      ['Letter portrait, 1 page', 1],
      ['A4 portrait, 2 pages', 1],
    ])
  })

  it('says what share of the type each group is, and which sizes were seen', () => {
    const [a4] = groupByShape(measured, [], measured.length)

    expect(a4?.percent).toBe(71)
    // Most common first; ties in the order first seen.
    expect(a4?.sizes).toHaveLength(4)
    expect(a4?.sizes[0]).toBe('595x841 (2)')
    expect(a4?.sizes).toEqual(
      expect.arrayContaining(['595x841 (2)', '595x842 (1)', '596x842 (1)', '594x842 (1)']),
    )
    expect(a4?.documentIds).toEqual(expect.arrayContaining([100, 101, 102, 103, 104]))
  })

  it('says which groups already have a template, whatever size the template was drawn on', () => {
    const groups = groupByShape(measured, [{ pageCount: 1, widthPt: 596, heightPt: 841 }], 7)

    expect(groups.map((g) => [g.label, g.hasTemplate])).toEqual([
      ['A4 portrait, 1 page', true],
      ['Letter portrait, 1 page', false],
      ['A4 portrait, 2 pages', false],
    ])
  })

  it('is empty for nothing measured', () => {
    expect(groupByShape([], [], 0)).toEqual([])
  })
})
