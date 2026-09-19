import { describe, expect, it } from 'vitest'
import type { DocumentTypeShapes } from '@asps-dms/shared'
import {
  ALL_SHAPES,
  defaultShapeKey,
  filterSamples,
  groupForKey,
  shapeOptions,
  shapesSummary,
} from '../../src/features/templates/sampleFilter.js'

/**
 * The shape filter on the sample list: which shape it opens on, what each
 * choice says, which samples it shows, and the line that says how far the
 * type's templates have got.
 */

const shapes: DocumentTypeShapes = {
  documentTypeId: 1,
  measured: 121,
  unmeasured: 0,
  groups: [
    {
      variant: { pageCount: 1, widthPt: 595, heightPt: 842 },
      label: 'A4 portrait, 1 page',
      documents: 110,
      percent: 91,
      sizes: ['595x842 (110)'],
      hasTemplate: true,
      documentIds: [1, 2, 3],
    },
    {
      variant: { pageCount: 2, widthPt: 595, heightPt: 842 },
      label: 'A4 portrait, 2 pages',
      documents: 8,
      percent: 7,
      sizes: ['595x842 (8)'],
      hasTemplate: false,
      documentIds: [4, 5],
    },
    {
      variant: { pageCount: 1, widthPt: 612, heightPt: 792 },
      label: 'Letter portrait, 1 page',
      documents: 3,
      percent: 2,
      sizes: ['612x792 (3)'],
      hasTemplate: false,
      documentIds: [6],
    },
  ],
}

const samples = [1, 2, 3, 4, 5, 6, 7].map((documentId) => ({
  documentId,
  employeeCode: `E${documentId}`,
}))

describe('defaultShapeKey', () => {
  it('opens on the largest shape that has no template', () => {
    expect(defaultShapeKey(shapes)).toBe('2p-portrait-1.42')
  })

  it('opens on the largest shape once every shape has a template', () => {
    const done = { ...shapes, groups: shapes.groups.map((g) => ({ ...g, hasTemplate: true })) }
    expect(defaultShapeKey(done)).toBe('1p-portrait-1.42')
  })

  it('has nothing to say before the shapes are measured, or when there are none', () => {
    expect(defaultShapeKey(undefined)).toBeNull()
    expect(defaultShapeKey({ ...shapes, groups: [] })).toBeNull()
  })
})

describe('shapeOptions', () => {
  it('names each shape with its count and whether a template exists, then offers all', () => {
    expect(shapeOptions(shapes).map((o) => o.label)).toEqual([
      'A4 portrait, 1 page - 110 documents - template saved',
      'A4 portrait, 2 pages - 8 documents - no template yet',
      'Letter portrait, 1 page - 3 documents - no template yet',
      'All shapes',
    ])
    expect(shapeOptions(shapes).at(-1)?.value).toBe(ALL_SHAPES)
  })

  it('says document, singular, for one', () => {
    const one = { ...shapes, groups: [{ ...shapes.groups[2]!, documents: 1 }] }
    expect(shapeOptions(one)[0]?.label).toBe(
      'Letter portrait, 1 page - 1 document - no template yet',
    )
  })
})

describe('filterSamples', () => {
  it('shows only the samples in the chosen shape', () => {
    expect(filterSamples(samples, shapes, '2p-portrait-1.42').map((s) => s.documentId)).toEqual([
      4, 5,
    ])
  })

  it('shows every sample for all shapes, before measuring, and for a shape that has gone', () => {
    expect(filterSamples(samples, shapes, ALL_SHAPES)).toHaveLength(7)
    expect(filterSamples(samples, undefined, '2p-portrait-1.42')).toHaveLength(7)
    expect(filterSamples(samples, shapes, '9p-landscape-9.99')).toHaveLength(7)
    expect(groupForKey(shapes, '9p-landscape-9.99')).toBeNull()
  })
})

describe('shapesSummary', () => {
  it('counts the shapes, the templates, and the documents the templates reach', () => {
    expect(shapesSummary(shapes, 'Appointment Letter')).toBe(
      '3 shapes: 1 with a template, 2 without. Templates cover 110 of 121 stored Appointment Letters (91%).',
    )
  })

  it('reads naturally for one shape fully covered', () => {
    const one = {
      ...shapes,
      measured: 5,
      groups: [{ ...shapes.groups[0]!, documents: 5, percent: 100 }],
    }
    expect(shapesSummary(one, 'ESIC Form')).toBe(
      '1 shape: 1 with a template, 0 without. Templates cover 5 of 5 stored ESIC Forms (100%).',
    )
  })

  it('says so when nothing could be measured, and nothing before measuring', () => {
    expect(shapesSummary({ ...shapes, measured: 0, groups: [] }, 'ESIC Form')).toBe(
      'No stored ESIC Forms could be measured yet.',
    )
    expect(shapesSummary(undefined, 'ESIC Form')).toBeNull()
  })
})
