import {
  DOCUMENT_FIELDS,
  DOCUMENT_FIELD_LABEL,
  FIELD_CHECK_RESULTS,
  TEXT_SOURCES,
  matchField,
  type DocumentField,
  type Employee,
  type FieldCheck,
  type IdentityCheck,
  type TextSource,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { extractText } from './documentText.service.js'

/**
 * Deciding whether an uploaded document belongs to the employee it is filed
 * against.
 *
 * The document is read - its own text layer where it has one, OCR where it does
 * not - and the details the document type asks for are looked for in that text.
 * documentText.service gets the words and document.service decides what to do
 * with the answer; this module only says what was found.
 *
 * The check is a GUARD, not a judgement of authenticity. It catches the mistake
 * it exists to prevent - one employee's form filed under another's record - and
 * it is deliberately literal about what counts as a match, because the cost of
 * being lenient is exactly the failure being guarded against. A real document
 * that fails, because a scan is too poor for OCR to read a digit, is accepted
 * by a person who records why.
 */

/**
 * Fields whose value is never echoed back to the screen.
 *
 * A refusal names the detail that could not be found. For a name or a joining
 * date, saying what was expected is what makes the message useful. For an
 * identity number it would turn the upload form into a way of reading one, so
 * those are reported by label only.
 */
const NEVER_ECHOED: ReadonlySet<DocumentField> = new Set([
  DOCUMENT_FIELDS.AADHAAR_NUMBER,
  DOCUMENT_FIELDS.PAN_NUMBER,
  DOCUMENT_FIELDS.UAN_NUMBER,
  DOCUMENT_FIELDS.ESI_NUMBER,
])

/**
 * What the employee record holds for each checkable field.
 *
 * One table rather than a switch buried in the comparison loop: adding a field
 * is a line here and a line in DOCUMENT_FIELD_MATCH, and there is a single
 * place to look when asking what a field is actually compared against.
 */
function recordedValue(employee: Employee, field: DocumentField): string | null {
  switch (field) {
    case DOCUMENT_FIELDS.EMPLOYEE_NAME:
      return employee.employeeName
    case DOCUMENT_FIELDS.EMPLOYEE_CODE:
      return employee.employeeCode
    case DOCUMENT_FIELDS.JOINING_DATE:
      return employee.joiningDate
    case DOCUMENT_FIELDS.DATE_OF_BIRTH:
      return employee.dateOfBirth
    case DOCUMENT_FIELDS.PHONE:
      return employee.phoneNumber
    case DOCUMENT_FIELDS.DESIGNATION:
      return employee.designation
    case DOCUMENT_FIELDS.POST_APPLIED_FOR:
      return employee.postAppliedFor
    case DOCUMENT_FIELDS.AADHAAR_NUMBER:
      return employee.aadhaarNumber
    case DOCUMENT_FIELDS.PAN_NUMBER:
      return employee.panNumber
    case DOCUMENT_FIELDS.CATEGORY_OF_WORKMEN:
      return employee.categoryOfWorkmen
    case DOCUMENT_FIELDS.UAN_NUMBER:
      return employee.uanNumber
    case DOCUMENT_FIELDS.ESI_NUMBER:
      return employee.esiNumber
    case DOCUMENT_FIELDS.APPOINTMENT_LETTER_DATE:
      return employee.appointmentLetterDate
  }
}

/**
 * Compares text already read out of a document with the employee's record.
 *
 * Kept apart from the reading so the rules can be tested against a plain
 * string, with no PDF, no OCR worker and no clock involved.
 *
 * A field the office never recorded comes back MissingOnRecord and does NOT
 * fail the check: refusing a document because an employee's phone number was
 * never typed in would send HR to rescan a document that was always fine, and
 * reporting the gap makes the real fix - filling the record in - the obvious
 * one. A document that could not be read fails every field it was asked about,
 * because nothing in it was confirmed.
 */
export function compareWithRecord(
  employee: Employee,
  fields: readonly DocumentField[],
  text: string,
  source: TextSource,
): IdentityCheck {
  const unreadable = source === TEXT_SOURCES.NONE || text.trim().length === 0

  const checks: FieldCheck[] = fields.map((field) => {
    const value = recordedValue(employee, field)
    const expected = NEVER_ECHOED.has(field) ? null : value

    if (value === null || value.trim().length === 0) {
      return { field, result: FIELD_CHECK_RESULTS.MISSING_ON_RECORD, expected }
    }

    const found = !unreadable && matchField(field, value, text)
    return {
      field,
      result: found ? FIELD_CHECK_RESULTS.MATCHED : FIELD_CHECK_RESULTS.NOT_FOUND,
      expected,
    }
  })

  const passed = checks.every((check) => check.result !== FIELD_CHECK_RESULTS.NOT_FOUND)

  return { passed, source, checks, unreadable }
}

/**
 * Reads an uploaded file and checks it against the employee.
 *
 * Returns null when there is nothing to check - the feature is switched off, or
 * this document type asks for no fields - which is a different answer from a
 * check that ran and passed, and is recorded as such on the document.
 *
 * The buffer is the file as it was uploaded, and it is read BEFORE anything is
 * written to disk: a document that is going to be refused should never have
 * been stored in the first place.
 */
export async function checkUpload(
  employee: Employee,
  fields: readonly DocumentField[],
  file: { buffer: Buffer; mimeType: string },
): Promise<IdentityCheck | null> {
  if (!env.IDENTITY_CHECK_ENABLED) return null
  if (fields.length === 0) return null

  const extracted = await extractText(file.buffer, file.mimeType)
  const result = compareWithRecord(employee, fields, extracted.text, extracted.source)

  logger.info(
    {
      employeeId: employee.employeeId,
      source: result.source,
      pagesRead: extracted.pagesRead,
      passed: result.passed,
      // The outcomes only - never the expected values, and never the text that
      // was read out of the employee's document.
      results: result.checks.map((check) => `${check.field}:${check.result}`),
    },
    'Identity check completed',
  )

  // Only on a failure, only when switched on, and never in passing traffic.
  // Without this, "the date is printed right there" and "OCR returned DATE OF
  // J0lNlNG" are indistinguishable from the outside, and only one of them is a
  // bug. See IDENTITY_CHECK_LOG_TEXT - it puts document contents in a log.
  if (!result.passed && env.IDENTITY_CHECK_LOG_TEXT) {
    logger.warn(
      { employeeId: employee.employeeId, source: result.source, text: extracted.text },
      'Identity check failed; this is what the document was read as',
    )
  }

  return result
}

/**
 * The sentence shown to whoever is uploading.
 *
 * Written as what to do next rather than as a verdict: the document may well be
 * the right one, badly scanned. It says which details could not be confirmed,
 * so the person can look at the page and see for themselves.
 */
export function describeFailure(check: IdentityCheck): string {
  if (check.unreadable) {
    return (
      'No text could be read from this file, so it could not be checked against ' +
      'the employee record. Check that it is the right document, then upload it ' +
      'again or accept it with a reason.'
    )
  }

  const missing = check.checks
    .filter((entry) => entry.result === FIELD_CHECK_RESULTS.NOT_FOUND)
    .map((entry) => DOCUMENT_FIELD_LABEL[entry.field].toLowerCase())

  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`

  return (
    `This document does not mention the employee's ${list}, so it may belong to ` +
    'someone else. Check that it is the right document, then upload it again or ' +
    'accept it with a reason.'
  )
}
