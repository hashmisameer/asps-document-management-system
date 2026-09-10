import { describe, expect, it } from 'vitest'
import { DOCUMENT_CHECKLIST, type DocumentType } from '@asps-dms/shared'
import { deadlineText } from '../../src/features/employees/deadlineText.js'

/**
 * The deadline column on the Add Employee screen.
 *
 * It used to be a box somebody could type into, and a date typed there was
 * written into the audit trail as a deliberate override of a decision nobody had
 * made. It is now read out of the checklist, which means the only thing left to
 * get wrong is what it says before there is a joining date to work from.
 */

/** A document type as the API returns it, from the checklist's own rules. */
function typeFor(documentCode: string): DocumentType {
  const rule = DOCUMENT_CHECKLIST.find((candidate) => candidate.documentCode === documentCode)
  if (!rule) throw new Error(`the checklist has no ${documentCode}`)

  return {
    documentTypeId: 1,
    documentName: rule.documentName,
    documentCode: rule.documentCode,
    isMandatory: rule.isMandatory,
    isActive: true,
    requiresSignature: false,
    deadlineValue: rule.deadlineValue,
    deadlineUnit: rule.deadlineUnit,
    sortOrder: 10,
    requiredFields: [],
    recognitionKeywords: [],
    refuseOnCheckFailure: false,
    requiredAtCreation: false,
    canBeMarkedNotRequired: false,
    createdAt: '2026-09-01T04:00:00.000Z',
    updatedAt: '2026-09-01T04:00:00.000Z',
  }
}

describe('the deadline column', () => {
  it('is blank until there is a joining date', () => {
    // Blank, not 'No deadline'. The appointment letter HAS a deadline; nobody
    // has said yet what it counts from.
    expect(deadlineText(typeFor('APPOINTMENT_LETTER'), '')).toBe('')
    expect(deadlineText(typeFor('AADHAAR_CARD'), '')).toBe('')
  })

  it('stays blank while the date is still being typed', () => {
    // A half-typed date gives no deadlines rather than nonsense ones.
    for (const halfTyped of ['2026', '2026-0', '2026-09', '2026-09-']) {
      expect(deadlineText(typeFor('SERVICE_CARD'), halfTyped), halfTyped).toBe('')
    }
  })

  it('fills in the moment the date is complete', () => {
    expect(deadlineText(typeFor('APPOINTMENT_LETTER'), '2026-09-01')).toBe('08/09/2026')
    expect(deadlineText(typeFor('SERVICE_CARD'), '2026-09-01')).toBe('08/09/2026')
  })

  it('moves every row when the joining date is corrected', () => {
    const type = typeFor('BIO_DATA')

    expect(deadlineText(type, '2026-09-01')).toBe('08/09/2026')
    expect(deadlineText(type, '2026-10-15')).toBe('22/10/2026')
  })

  it("says 'No deadline' for the four that never fall due", () => {
    for (const code of ['AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM']) {
      expect(deadlineText(typeFor(code), '2026-09-01'), code).toBe('No deadline')
    }
  })

  it('counts the confirmation letter in calendar months', () => {
    expect(deadlineText(typeFor('CONFIRMATION_LETTER'), '2026-09-01')).toBe('01/03/2027')
    // 31 August has no answer in February, so it lands on the last day of it.
    expect(deadlineText(typeFor('CONFIRMATION_LETTER'), '2026-08-31')).toBe('28/02/2027')
  })
})
