import {
  DOCUMENT_FIELDS,
  DOCUMENT_FIELD_LABEL,
  FIELD_CHECK_RESULTS,
  IDENTIFYING_DOCUMENT_FIELDS,
  IDENTITY_CARD_DOCUMENT_CODES,
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
import { logSafeText } from '../utils/redact.js'
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
 * NOTHING HERE REFUSES AN UPLOAD. It used to, and for the two identity cards a
 * failure went as far as deleting the stored file again. That was wrong for
 * this company: all 550 employees' PAN and Aadhaar documents are low-contrast
 * JPG photocopies, so OCR failing to read a name off one is the NORMAL case,
 * not a warning sign - and the system was treating the normal case as an error
 * and making somebody type a sentence about it every single time.
 *
 * What this module now produces is advice. A document is stored whatever comes
 * back; the answer decides whether the screen says the name was confirmed
 * automatically or asks a person to confirm it with one click.
 */

/**
 * How well a page must have been read before its words are used to ACCUSE.
 *
 * Tesseract's own score, 0 to 100. Above this the reading is good enough to say
 * 'this looks like a different document type'; below it, the absence of the
 * expected wording says more about the photocopier than about the document.
 *
 * A starting figure rather than a measured one, and it is here on its own line
 * to be changed. Every reading's confidence is logged, so a week of this
 * office's real uploads will say what it should actually be.
 */
export const MIN_CONFIDENT_READING = 75

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
  /**
   * How sure the reading was, 0 to 100. Defaults to certain.
   *
   * Only the wrong-type warning depends on it. A PDF's own text layer and the
   * tests are certain by definition; an OCR pass over a photocopy is not.
   */
  confidence = 100,
): IdentityCheck {
  const unreadable = source === TEXT_SOURCES.NONE || text.trim().length === 0

  // Is this the document it is being filed as?
  //
  // Asked first, and separately from the field checks, because those cannot
  // answer it: an employee's name and code are printed on every document they
  // own, so an Aadhaar card filed against the PAN Card row passes all of them.
  //
  // null when the type carries no keywords - not recognised is a different
  // answer from recognised and wrong, and only the second says anything.
  //
  // AND null when the reading was poor. Saying 'this looks like a different
  // document' is close to telling somebody they filed the wrong paper, and it
  // has to be earned: on a low-contrast photocopy Tesseract scores in the
  // forties and returns text that resembles nothing at all, from which
  // 'the keywords are absent' means only that the reading was bad. A false
  // accusation over a genuine document is worse than saying nothing.
  const trustworthy = confidence >= MIN_CONFIDENT_READING
  const typeRecognised =
    recognitionKeywords.length === 0 || unreadable || !trustworthy
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
  /** The type's code, which is how the identity cards are recognised here. */
  documentCode?: string,
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

  const extracted = await extractText(
    file.buffer,
    file.mimeType,
    enough,
    languagesFor(documentCode),
  )
  const result = compareWithRecord(
    employee,
    fields,
    extracted.text,
    extracted.source,
    recognitionKeywords,
    extracted.confidence,
  )

  // Logged BEFORE the outcome is acted on, and with what is needed to work out
  // why a reading went the way it did: what the employee is called, how sure
  // Tesseract was, and the opening of what it made of the page.
  //
  // The text is MASKED AND THEN CUT SHORT - see redact.ts. This line runs on
  // every upload, and these log files are never rotated, so the full text of
  // 550 identity cards would otherwise accumulate on disk beside the
  // application. What survives answers the two questions worth asking: did it
  // read anything at all, and was the name in it.
  logger.info(
    {
      employeeId: employee.employeeId,
      documentName,
      employeeName: employee.employeeName,
      source: result.source,
      confidence: Math.round(extracted.confidence),
      pagesRead: extracted.pagesRead,
      matched: result.identityConfirmed,
      passed: result.passed,
      results: result.checks.map((check) => `${check.field}:${check.result}`),
      ...(env.IDENTITY_CHECK_LOG_TEXT ? { textPreview: logSafeText(extracted.text) } : {}),
    },
    'Identity check completed',
  )

  return result
}

/**
 * Which languages to read a document type in.
 *
 * ENGLISH ONLY FOR THE TWO IDENTITY CARDS. Both are printed in English, and
 * reading them with the Hindi model as well is actively harmful rather than
 * merely wasteful: Tesseract finds Devanagari marks in the noise of a
 * photocopy and hangs them off the English letters - the office's logs show
 * 'Detected 122 diacritics' on a PAN card - so a name that would have matched
 * comes back decorated and does not.
 *
 * Everything else keeps the configured behaviour, because the company's
 * appointment letter really is printed in Hindi.
 */
function languagesFor(documentCode: string | undefined): string | undefined {
  if (!documentCode) return undefined
  return (IDENTITY_CARD_DOCUMENT_CODES as readonly string[]).includes(documentCode)
    ? ENGLISH_ONLY
    : undefined
}

const ENGLISH_ONLY = 'eng'

/**
 * What could not be confirmed, in words, for whoever uploaded it.
 *
 * A WARNING, NOT A REFUSAL. The document is stored either way; this sentence
 * exists so somebody can glance at the page and confirm it themselves.
 *
 * Every identity card at this company is a low-contrast photocopy, so a name
 * that will not read off one is the ORDINARY case and not a sign of anything.
 * The wording has to match that. What used to be said here - that a document
 * 'may belong to someone else' - reads as an accusation, and it was being made
 * against HR staff filing perfectly good paperwork, hundreds of times over.
 *
 * So nothing here suggests the document is wrong. It says what the machine
 * could not read, which is the only thing actually known.
 */
export function describeFailure(
  check: IdentityCheck,
  /**
   * Kept in the signature and deliberately unused.
   *
   * The old wording named the document - 'This does not look like a PAN Card' -
   * and naming it is exactly what made the sentence read as a charge against
   * the person filing it. The row already says which document it is; the
   * warning does not need to say it back.
   */
  _documentName?: string,
): string {
  // Only reachable on a reading good enough to be worth repeating - see
  // MIN_CONFIDENT_READING. 'Please check', not 'you have filed the wrong paper':
  // the reading is confident, not correct.
  if (check.typeRecognised === false) {
    return 'This looks like a different document type. Please check before confirming.'
  }

  if (check.unreadable || !check.identityConfirmed) {
    return 'Could not read the name from this document. Please confirm manually.'
  }

  // The name WAS found - this is some other detail the type asks for, such as a
  // joining date struck through in pen. Named, because a person can look for it.
  const missing = check.checks
    .filter((entry) => entry.result === FIELD_CHECK_RESULTS.NOT_FOUND)
    .map((entry) => DOCUMENT_FIELD_LABEL[entry.field].toLowerCase())

  if (missing.length === 0) {
    return 'Could not read the name from this document. Please confirm manually.'
  }

  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`

  return `Could not read the ${list} from this document. Please confirm manually.`
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
  // English only. This path exists for the Aadhaar and PAN cards and for
  // nothing else, both are printed in English, and the Hindi model decorates
  // English letters with marks it finds in the noise of a photocopy.
  const extracted = await extractText(
    file.buffer,
    file.mimeType,
    (text) => matchWords(expectedName, text),
    ENGLISH_ONLY,
  )

  const readable = extracted.source !== TEXT_SOURCES.NONE && extracted.text.trim().length > 0
  const matched = readable && matchWords(expectedName, extracted.text)

  logger.info(
    {
      documentName,
      employeeName: expectedName,
      source: extracted.source,
      confidence: Math.round(extracted.confidence),
      readable,
      matched,
      ...(env.IDENTITY_CHECK_LOG_TEXT ? { textPreview: logSafeText(extracted.text) } : {}),
    },
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
