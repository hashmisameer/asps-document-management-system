import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_FIELDS,
  FIELD_CHECK_RESULTS,
  TEXT_SOURCES,
  type Employee,
} from '@asps-dms/shared'
import { compareWithRecord, describeFailure } from '../../src/services/documentVerification.service.js'

/**
 * Comparing a document's text with the employee record.
 *
 * These are the rules that decide whether an upload is refused, so what is
 * pinned here is the behaviour that would be expensive to get wrong: a document
 * belonging to someone else fails, a detail the office never recorded does not
 * fail anything, and an identity number is never echoed back to the screen.
 */

// asps-dms:allow-secret - the documented placeholder PAN, not anyone's.
const FIXTURE_PAN = 'ABCDE1234F'

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    employeeId: 42,
    employeeCode: 'EMP007',
    employeeName: 'Ravi Kumar',
    joiningDate: '2026-04-01',
    department: 'Accounts',
    designation: 'Accounts Officer',
    phoneNumber: '9876543210',
    dateOfBirth: '1990-08-15',
    gender: null,
    postAppliedFor: null,
    categoryOfWorkmen: null,
    aadhaarNumber: '123456789012',
    panNumber: FIXTURE_PAN,
    uanNumber: null,
    esiNumber: null,
    appointmentLetterDate: null,
    hasPhoto: false,
    photoUpdatedAt: null,
    isActive: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  }
}

const SERVICE_CARD = `
  ASPS INTERNATIONAL - SERVICE CARD
  Name: KUMAR, RAVI          Employee Code: EMP 007
  Date of Joining: 01/04/2026    Date of Birth: 15th August, 1990
  Mobile: +91 98765-43210
  Aadhaar No. 1234 5678 9012     PAN: ${FIXTURE_PAN}
  Designation: Accounts Officer
`

describe('compareWithRecord', () => {
  it('passes a document that carries every detail asked for, however it spells them', () => {
    const result = compareWithRecord(
      employee(),
      [
        DOCUMENT_FIELDS.EMPLOYEE_NAME,
        DOCUMENT_FIELDS.EMPLOYEE_CODE,
        DOCUMENT_FIELDS.JOINING_DATE,
        DOCUMENT_FIELDS.DATE_OF_BIRTH,
        DOCUMENT_FIELDS.PHONE,
        DOCUMENT_FIELDS.AADHAAR_NUMBER,
        DOCUMENT_FIELDS.PAN_NUMBER,
      ],
      SERVICE_CARD,
      TEXT_SOURCES.PDF_TEXT,
    )

    expect(result.passed).toBe(true)
    expect(result.unreadable).toBe(false)
    expect(result.checks.every((check) => check.result === FIELD_CHECK_RESULTS.MATCHED)).toBe(true)
  })

  it('fails a document that belongs to someone else', () => {
    const result = compareWithRecord(
      employee({ employeeName: 'Anita Desai', employeeCode: 'EMP113' }),
      [DOCUMENT_FIELDS.EMPLOYEE_NAME, DOCUMENT_FIELDS.EMPLOYEE_CODE],
      SERVICE_CARD,
      TEXT_SOURCES.PDF_TEXT,
    )

    expect(result.passed).toBe(false)
    expect(result.checks.map((check) => check.result)).toEqual([
      FIELD_CHECK_RESULTS.NOT_FOUND,
      FIELD_CHECK_RESULTS.NOT_FOUND,
    ])
  })

  it('reports a detail the office never recorded, and does not fail the document for it', () => {
    const result = compareWithRecord(
      employee({ uanNumber: null }),
      [DOCUMENT_FIELDS.EMPLOYEE_NAME, DOCUMENT_FIELDS.UAN_NUMBER],
      SERVICE_CARD,
      TEXT_SOURCES.PDF_TEXT,
    )

    expect(result.passed).toBe(true)
    expect(result.checks[1]?.result).toBe(FIELD_CHECK_RESULTS.MISSING_ON_RECORD)
  })

  it('never echoes an identity number back, and does echo the details that help', () => {
    const result = compareWithRecord(
      employee(),
      [
        DOCUMENT_FIELDS.EMPLOYEE_NAME,
        DOCUMENT_FIELDS.AADHAAR_NUMBER,
        DOCUMENT_FIELDS.PAN_NUMBER,
      ],
      SERVICE_CARD,
      TEXT_SOURCES.PDF_TEXT,
    )

    expect(result.checks[0]?.expected).toBe('Ravi Kumar')
    expect(result.checks[1]?.expected).toBeNull()
    expect(result.checks[2]?.expected).toBeNull()
  })

  it('fails every field when nothing could be read out of the file', () => {
    const result = compareWithRecord(
      employee(),
      [DOCUMENT_FIELDS.EMPLOYEE_NAME],
      '',
      TEXT_SOURCES.NONE,
    )

    expect(result.unreadable).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.checks[0]?.result).toBe(FIELD_CHECK_RESULTS.NOT_FOUND)
  })

  it('passes with nothing to check when the document type asks for no fields', () => {
    const result = compareWithRecord(employee(), [], SERVICE_CARD, TEXT_SOURCES.PDF_TEXT)

    expect(result.passed).toBe(true)
    expect(result.checks).toEqual([])
  })
})

describe('describeFailure', () => {
  it('names the details that could not be found, without quoting an identity number', () => {
    const result = compareWithRecord(
      employee({ employeeName: 'Anita Desai', aadhaarNumber: '999988887777' }),
      [DOCUMENT_FIELDS.EMPLOYEE_NAME, DOCUMENT_FIELDS.AADHAAR_NUMBER],
      SERVICE_CARD,
      TEXT_SOURCES.PDF_TEXT,
    )

    const message = describeFailure(result)

    expect(message).toContain('employee name')
    expect(message).toContain('aadhaar number')
    expect(message).not.toContain('999988887777')
  })

  it('says the file could not be read when that is what happened', () => {
    const result = compareWithRecord(
      employee(),
      [DOCUMENT_FIELDS.EMPLOYEE_NAME],
      '',
      TEXT_SOURCES.NONE,
    )

    expect(describeFailure(result)).toContain('No text could be read')
  })
})
