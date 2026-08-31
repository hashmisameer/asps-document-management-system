/**
 * The employee details a document can be checked against.
 *
 * When a document is uploaded it is read and compared with the employee's own
 * record, so a form belonging to one person cannot be filed against another.
 * Which fields are checked is CONFIGURATION, held per document type: a PF form
 * carries only a name, while a service card carries nine things. Hard-coding
 * the list per type in the service would mean a code change every time the
 * office revises a form.
 *
 * Each field also says HOW it is compared, because the answer differs: a name
 * is matched word by word, a date has a dozen written forms that all mean the
 * same day, and an Aadhaar number is twelve digits that either agree or do not.
 */

export const DOCUMENT_FIELDS = {
  EMPLOYEE_NAME: 'EmployeeName',
  EMPLOYEE_CODE: 'EmployeeCode',
  JOINING_DATE: 'JoiningDate',
  DATE_OF_BIRTH: 'DateOfBirth',
  PHONE: 'Phone',
  DESIGNATION: 'Designation',
  POST_APPLIED_FOR: 'PostAppliedFor',
  AADHAAR_NUMBER: 'AadhaarNumber',
  PAN_NUMBER: 'PanNumber',
  CATEGORY_OF_WORKMEN: 'CategoryOfWorkmen',
  UAN_NUMBER: 'UanNumber',
  ESI_NUMBER: 'EsiNumber',
  APPOINTMENT_LETTER_DATE: 'AppointmentLetterDate',
} as const

export type DocumentField = (typeof DOCUMENT_FIELDS)[keyof typeof DOCUMENT_FIELDS]

export const ALL_DOCUMENT_FIELDS: readonly DocumentField[] = Object.values(DOCUMENT_FIELDS)

/** What the field is called on screen and in the message that refuses an upload. */
export const DOCUMENT_FIELD_LABEL: Readonly<Record<DocumentField, string>> = {
  [DOCUMENT_FIELDS.EMPLOYEE_NAME]: 'Employee name',
  [DOCUMENT_FIELDS.EMPLOYEE_CODE]: 'Employee code',
  [DOCUMENT_FIELDS.JOINING_DATE]: 'Date of joining',
  [DOCUMENT_FIELDS.DATE_OF_BIRTH]: 'Date of birth',
  [DOCUMENT_FIELDS.PHONE]: 'Mobile number',
  [DOCUMENT_FIELDS.DESIGNATION]: 'Designation',
  [DOCUMENT_FIELDS.POST_APPLIED_FOR]: 'Post applied for',
  [DOCUMENT_FIELDS.AADHAAR_NUMBER]: 'Aadhaar number',
  [DOCUMENT_FIELDS.PAN_NUMBER]: 'PAN number',
  [DOCUMENT_FIELDS.CATEGORY_OF_WORKMEN]: 'Category of workmen',
  [DOCUMENT_FIELDS.UAN_NUMBER]: 'UAN number',
  [DOCUMENT_FIELDS.ESI_NUMBER]: 'ESI number',
  [DOCUMENT_FIELDS.APPOINTMENT_LETTER_DATE]: 'Appointment letter date',
}

/**
 * How each field is compared with what was read out of the document.
 *
 *   name   - every word of the name must appear, in any order or case
 *   code   - the employee code, tolerating a space inside it (EMP 007)
 *   date   - any written form of the same calendar day
 *   digits - a run of digits, ignoring spaces and hyphens
 *   pan    - the PAN pattern, compared exactly
 *   text   - every significant word must appear, like a name
 */
export const DOCUMENT_FIELD_MATCH: Readonly<
  Record<DocumentField, 'name' | 'code' | 'date' | 'digits' | 'pan' | 'text'>
> = {
  [DOCUMENT_FIELDS.EMPLOYEE_NAME]: 'name',
  [DOCUMENT_FIELDS.EMPLOYEE_CODE]: 'code',
  [DOCUMENT_FIELDS.JOINING_DATE]: 'date',
  [DOCUMENT_FIELDS.DATE_OF_BIRTH]: 'date',
  [DOCUMENT_FIELDS.PHONE]: 'digits',
  [DOCUMENT_FIELDS.DESIGNATION]: 'text',
  [DOCUMENT_FIELDS.POST_APPLIED_FOR]: 'text',
  [DOCUMENT_FIELDS.AADHAAR_NUMBER]: 'digits',
  [DOCUMENT_FIELDS.PAN_NUMBER]: 'pan',
  [DOCUMENT_FIELDS.CATEGORY_OF_WORKMEN]: 'text',
  [DOCUMENT_FIELDS.UAN_NUMBER]: 'digits',
  [DOCUMENT_FIELDS.ESI_NUMBER]: 'digits',
  [DOCUMENT_FIELDS.APPOINTMENT_LETTER_DATE]: 'date',
}

/**
 * Why a field check came out the way it did.
 *
 * MISSING_ON_RECORD is separated from NOT_FOUND deliberately: one says the
 * document does not mention something, and the other says the office never
 * recorded it. They are different problems with different fixes, and reporting
 * an incomplete employee record as a bad document would send HR to rescan a
 * document that was fine all along.
 */
export const FIELD_CHECK_RESULTS = {
  MATCHED: 'Matched',
  NOT_FOUND: 'NotFound',
  MISSING_ON_RECORD: 'MissingOnRecord',
} as const

export type FieldCheckResult = (typeof FIELD_CHECK_RESULTS)[keyof typeof FIELD_CHECK_RESULTS]

/** How the text being checked was obtained. Recorded, because it bears on trust. */
export const TEXT_SOURCES = {
  /** A real PDF text layer. Exact - these characters are what the file says. */
  PDF_TEXT: 'PdfText',
  /** Read off the pixels. Good, not perfect: a digit can come back wrong. */
  OCR: 'Ocr',
  /** Neither worked - an image-only PDF that OCR could not read, say. */
  NONE: 'None',
} as const

export type TextSource = (typeof TEXT_SOURCES)[keyof typeof TEXT_SOURCES]

/**
 * The shortest override reason that will be accepted.
 *
 * Long enough that "ok" or "." will not do, since a reason nobody can act on
 * defeats the point of recording one, and short enough not to obstruct someone
 * writing a genuine sentence. The upload form and the schema share this number
 * so the button enables at exactly the moment the request would be accepted.
 */
export const MIN_IDENTITY_OVERRIDE_REASON_LENGTH = 10
