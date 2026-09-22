import { describe, expect, it } from 'vitest'
import type { DocumentTypeShapes } from '@asps-dms/shared'
import {
  describeShape,
  sampleIsCovered,
  savedTemplatesNote,
} from '../../src/features/templates/shapeText.js'

/**
 * What the template editor says beside a sample: which shape it is, how much
 * of the type that covers, and the warning when it is only a few.
 */

const A4 = { pageCount: 1, widthPt: 595, heightPt: 842 }
const LETTER = { pageCount: 1, widthPt: 612, heightPt: 792 }

const shapes: DocumentTypeShapes = {
  documentTypeId: 1,
  measured: 121,
  unmeasured: 2,
  groups: [
    {
      variant: A4,
      label: 'A4 portrait, 1 page',
      documents: 118,
      percent: 98,
      sizes: ['595x842 (110)', '596x842 (8)'],
      hasTemplate: true,
      documentIds: [1, 2, 3],
    },
    {
      variant: LETTER,
      label: 'Letter portrait, 1 page',
      documents: 3,
      percent: 2,
      sizes: ['612x792 (3)'],
      hasTemplate: false,
      documentIds: [9],
    },
  ],
}

describe('describeShape', () => {
  it('names the shape and says how much of the type it covers', () => {
    const line = describeShape(
      { pageCount: 1, widthPt: 596, heightPt: 841 },
      shapes,
      'Appointment Letter',
    )

    expect(line.label).toBe('A4 portrait, 1 page')
    expect(line.coverage).toBe('118 of 121 stored Appointment Letters are this shape (98%).')
    expect(line.group?.hasTemplate).toBe(true)
    expect(line.warning).toBeNull()
  })

  it('warns when the sample is a shape only a few documents have, and names the common one', () => {
    const line = describeShape(LETTER, shapes, 'Appointment Letter')

    expect(line.coverage).toBe('3 of 121 stored Appointment Letters are this shape (2%).')
    expect(line.warning).toBe(
      'Only 3 of 121 stored Appointment Letters are Letter portrait, 1 page. A template drawn on this sample will be used for those documents and no others; 118 are A4 portrait, 1 page. Is this the right sample?',
    )
  })

  it('warns for a shape no stored document has at all', () => {
    const line = describeShape(
      { pageCount: 2, widthPt: 595, heightPt: 842 },
      shapes,
      'Appointment Letter',
    )

    expect(line.coverage).toBe('0 of 121 stored Appointment Letters are this shape (0%).')
    expect(line.warning).toContain('Only 0 of 121')
  })

  it('does not call three of three rare: with only a handful stored, every shape is all of them', () => {
    const few: DocumentTypeShapes = {
      ...shapes,
      measured: 3,
      groups: [{ ...shapes.groups[0]!, documents: 3, percent: 100 }],
    }
    expect(describeShape(A4, few, 'ESIC Form').warning).toBeNull()
    expect(describeShape(A4, few, 'ESIC Form').coverage).toBe(
      '3 of 3 stored ESIC Forms are this shape (100%).',
    )
  })

  it('says nothing about coverage until the documents have been measured', () => {
    const line = describeShape(A4, undefined, 'ESIC Form')
    expect(line.label).toBe('A4 portrait, 1 page')
    expect(line.coverage).toBeNull()
    expect(line.warning).toBeNull()
  })

  it('says so when nothing could be measured', () => {
    expect(describeShape(A4, { ...shapes, measured: 0, groups: [] }, 'ESIC Form').coverage).toBe(
      'No stored ESIC Forms could be measured yet.',
    )
  })
})

describe('sampleIsCovered', () => {
  it('says which samples a template on this shape would cover', () => {
    expect(sampleIsCovered(shapes, A4, 2)).toBe(true)
    expect(sampleIsCovered(shapes, A4, 9)).toBe(false)
    expect(sampleIsCovered(shapes, LETTER, 9)).toBe(true)
  })

  it('does not know until measured, or without a sample on screen', () => {
    expect(sampleIsCovered(undefined, A4, 2)).toBeNull()
    expect(sampleIsCovered(shapes, null, 2)).toBeNull()
  })
})

describe('savedTemplatesNote', () => {
  it('says nothing for the normal case of one saved template', () => {
    expect(savedTemplatesNote(1)).toBeNull()
    expect(savedTemplatesNote(0)).toBeNull()
  })

  it('says how many saved templates a shape holds, which is used, and how to tidy it', () => {
    expect(savedTemplatesNote(3)).toBe(
      '3 saved templates are this shape - the newest is used. Save it once to keep only that one.',
    )
  })
})
