import { describe, expect, it } from 'vitest'
import {
  documentEmployeesQuerySchema,
  printDocumentEmployeesQuerySchema,
} from '@asps-dms/shared'

/**
 * The query behind a type's page, its printed list and its spreadsheet: the
 * upload-date range must be two real office days, the first no later than the
 * second, and the same rule on every one of the three.
 */
describe('the upload-date range', () => {
  for (const [name, schema] of [
    ['the page', documentEmployeesQuerySchema],
    ['the printed list and the spreadsheet', printDocumentEmployeesQuerySchema],
  ] as const) {
    it(`is accepted on ${name}, either end or both`, () => {
      expect(schema.parse({ uploadedFrom: '2026-10-29', uploadedTo: '2026-10-30' })).toMatchObject({
        uploadedFrom: '2026-10-29',
        uploadedTo: '2026-10-30',
      })
      expect(schema.parse({ uploadedFrom: '2026-10-29' }).uploadedTo).toBeUndefined()
      expect(schema.parse({ uploadedTo: '2026-10-30' }).uploadedFrom).toBeUndefined()
      expect(schema.parse({ uploadedFrom: '2026-10-30', uploadedTo: '2026-10-30' })).toBeDefined()
    })

    it(`refuses a range that ends before it starts, on ${name}`, () => {
      const result = schema.safeParse({ uploadedFrom: '2026-10-30', uploadedTo: '2026-10-29' })
      expect(result.success).toBe(false)
    })

    it(`refuses a date that is not a real day, on ${name}`, () => {
      expect(schema.safeParse({ uploadedFrom: '2026-02-30' }).success).toBe(false)
      expect(schema.safeParse({ uploadedTo: '30/10/2026' }).success).toBe(false)
    })
  }

  it('sorts by when the document was received', () => {
    expect(documentEmployeesQuerySchema.parse({ sortBy: 'uploadedAt' }).sortBy).toBe('uploadedAt')
  })
})
