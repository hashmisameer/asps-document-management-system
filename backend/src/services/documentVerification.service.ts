import {
  DOCUMENT_FIELDS,
  DOCUMENT_FIELD_LABEL,
  FIELD_CHECK_RESULTS,
  IDENTIFYING_DOCUMENT_FIELDS,
  TEXT_SOURCES,
  matchField,
  matchWords,
  matchesDocumentType,
  nameOnDocument,
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
  recognitionKeywords: readonly string[] = [],
): IdentityCheck {
  const unreadable = source === TEXT_SOURCES.NONE || text.trim().length === 0

  // Is this the document it is being filed as?
  //
  // Asked first, and separately from the field checks, because those cannot
  // answer it: an employee's name and code are printed on every document they
  // own, so an Aadhaar card filed against the PAN Card row passes all of them.
  //
  // null when the type carries no keywords - not recognised is a different
  // answer from recognised and wrong, and only the second refuses anything.
  const typeRecognised =
    recognitionKeywords.length === 0 || unreadable
      ? null
      : matchesDocumentType(text, recognitionKeywords)

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

  // Whose document is this?
  //
  // An identifying field that MATCHED settles it. Every field having to match
  // was the rule before, and it refused documents nobody could call wrong: the
  // office's service card carries the employee's name and code, and its joining
  // date is struck through in red pen, so OCR returns 'DATE OF JOINING fom'.
  // Under the old rule that card was refused as possibly somebody else's, with
  // that person's own name printed across the top of it.
  //
  // The guard this exists for is unaffected. Filing one employee's form against
  // another's record still fails, because the name and code on the page are the
  // other employee's and neither will match. What no longer fails is a document
  // that names the right person and was read imperfectly - which is the common
  // case, and was costing an override every time.
  const identityConfirmed = checks.some(
    (check) =>
      IDENTIFYING_DOCUMENT_FIELDS.has(check.field) &&
      check.result === FIELD_CHECK_RESULTS.MATCHED,
  )

  // Types that ask for no identifying field at all - if one is ever configured
  // that way - keep the old all-or-nothing rule, since there is nothing else to
  // go on.
  const asksForIdentity = fields.some((field) => IDENTIFYING_DOCUMENT_FIELDS.has(field))

  const passed =
    typeRecognised !== false &&
    (identityConfirmed ||
      (!asksForIdentity &&
        checks.every((check) => check.result !== FIELD_CHECK_RESULTS.NOT_FOUND)))

  return { passed, identityConfirmed, source, checks, unreadable, typeRecognised }
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
  recognitionKeywords: readonly string[] = [],
  /**
   * Which document this is, for the log only.
   *
   * A failure used to be recorded against an employee and nothing else, so
   * working out whether a capture was the bio data form or the gratuity form
   * meant matching timestamps against what somebody remembered clicking. Names
   * of document TYPES are not employee data; the file's own name is not
   * recorded here for the same reason its contents are not.
   */
  documentName?: string,
): Promise<IdentityCheck | null> {
  if (!env.IDENTITY_CHECK_ENABLED) return null
  // Nothing to check only when the type asks for NEITHER - no fields to confirm
  // and no wording to recognise it by.
  if (fields.length === 0 && recognitionKeywords.length === 0) return null

  // What "enough" means here is exactly what the check is about to ask, so the
  // reading can stop the moment the answer is yes: no further pages, and no
  // second pass in other languages. It only ever ends work early - the same
  // comparison runs again below on whatever text came back.
  const enough = (text: string): boolean =>
    compareWithRecord(employee, fields, text, TEXT_SOURCES.OCR, recognitionKeywords).passed

  const extracted = await extractText(file.buffer, file.mimeType, enough)
  const result = compareWithRecord(
    employee,
    fields,
    extracted.text,
    extracted.source,
    recognitionKeywords,
  )

  logger.info(
    {
      employeeId: employee.employeeId,
      documentName,
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
      { employeeId: employee.employeeId, documentName, source: result.source, text: extracted.text },
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
export function describeFailure(check: IdentityCheck, documentName?: string): string {
  // Said first, because it is the more useful thing to be told. "This is not a
  // PAN card" sends somebody to find the right file; "the PAN number was not
  // found" sends them to squint at the wrong one.
  if (check.typeRecognised === false) {
    // 'an Aadhaar Card', not 'a Aadhaar Card'. A refusal is read by somebody who
    // is already mildly annoyed; it should not also read as broken English.
    const named = documentName
      ? `${/^[AEIOU]/i.test(documentName) ? 'an' : 'a'} ${documentName}`
      : 'the right document'
    return (
      `This does not look like ${named}. ` +
      'Check that the right file was chosen, then upload it again or accept it with a reason.'
    )
  }

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

  // 'It may belong to someone else' is only ever said when nothing on the page
  // identified the employee. Where the name or the code DID match, that sentence
  // was simply untrue - it was printed over a document with the right person's
  // name on it - and an upload that reaches this point without identity
  // confirmed no longer happens for that reason anyway.
  if (check.identityConfirmed) {
    return (
      `This document is the right employee's, but their ${list} could not be ` +
      'read from it. Upload it again or accept it with a reason.'
    )
  }

  return (
    `This document does not mention the employee's ${list}, so it may belong to ` +
    'someone else. Check that it is the right document, then upload it again or ' +
    'accept it with a reason.'
  )
}

/**
 * Whether a file names a person, before any employee record exists.
 *
 * The Add Employee screen collects the two identity cards BEFORE the record is
 * created, so there is no document row to attach them to and nothing for the
 * ordinary check to run against. Without this, those two cards were the only
 * documents in the system nobody checked - they were attached on trust and read
 * only later, after the employee had been created around them.
 *
 * Nothing is stored. The file is read, compared with the name that has been
 * typed on the form, and forgotten.
 */
export async function checkNameOnly(
  file: { buffer: Buffer; mimeType: string },
  expectedName: string,
  documentName: string,
): Promise<{ readable: boolean; matched: boolean; nameFound: string | null }> {
  const extracted = await extractText(file.buffer, file.mimeType, (text) =>
    matchWords(expectedName, text),
  )

  const readable = extracted.source !== TEXT_SOURCES.NONE && extracted.text.trim().length > 0
  const matched = readable && matchWords(expectedName, extracted.text)

  logger.info(
    { documentName, source: extracted.source, readable, matched },
    'Identity documents checked before the employee record exists',
  )

  return {
    readable,
    matched,
    // Only worth reporting when it disagrees. Offered as context for a person
    // deciding, never as grounds for the decision itself.
    nameFound: matched ? null : nameOnDocument(extracted.text),
  }
}
