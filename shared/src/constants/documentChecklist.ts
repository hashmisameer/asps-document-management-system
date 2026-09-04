import { DEADLINE_UNITS, type DeadlineUnit } from './deadlines.js'

/**
 * The checklist: every document the company collects, and what it expects.
 *
 * THE ONE PLACE THIS IS DECIDED. It was configurable - a Settings screen wrote
 * it into dbo.DocumentTypes - and the office asked for it back in code: the list
 * has been the same ten documents for years, and a screen that can change it is
 * a screen somebody changes by accident on a Friday.
 *
 * The database still holds a row per type, because every checklist row points at
 * one and a file uploaded years ago has to keep pointing at something. What it
 * no longer holds is the DECISION: the flags below are applied over each row as
 * it is read, so the table can drift and the application cannot.
 *
 * MANDATORY means the document must be collected - chased, counted, allowed to
 * go overdue. It does NOT mean it must be in hand before the employee record can
 * be created; nothing is.
 *
 * A NULL DEADLINE means the document is collected but never falls due. Those
 * four are chased by hand: the identity cards because they usually arrive with
 * the person, the two statutory forms because they are filed with the government
 * rather than collected from the employee.
 *
 * CHANGING SOMETHING HERE DOES NOT MOVE ANYBODY'S EXISTING DEADLINE. A due date
 * is written onto the employee's row when they are created, from this list as it
 * stood that day, and it stays there. Shortening a deadline would otherwise make
 * a hundred people overdue between one deployment and the next, for a document
 * nobody had been late with the day before.
 */

export interface ChecklistRule {
  /** The code that identifies this document for ever. */
  documentCode: string
  documentName: string
  isMandatory: boolean
  /** Null together with the unit: a document that is collected but never due. */
  deadlineValue: number | null
  deadlineUnit: DeadlineUnit | null
}

export const DOCUMENT_CHECKLIST: readonly ChecklistRule[] = [
  {
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'BIO_DATA',
    documentName: 'Bio Data Form',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'AADHAAR_CARD',
    documentName: 'Aadhaar Card',
    isMandatory: true,
    deadlineValue: null,
    deadlineUnit: null,
  },
  {
    documentCode: 'PAN_CARD',
    documentName: 'PAN Card',
    isMandatory: true,
    deadlineValue: null,
    deadlineUnit: null,
  },
  {
    documentCode: 'PF_FORM',
    documentName: 'PF Form',
    isMandatory: false,
    deadlineValue: null,
    deadlineUnit: null,
  },
  {
    documentCode: 'ESIC_FORM',
    documentName: 'ESIC Form',
    isMandatory: false,
    deadlineValue: null,
    deadlineUnit: null,
  },
  {
    documentCode: 'SERVICE_CARD',
    documentName: 'Service Card',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'GRATUITY_FORM',
    documentName: 'Payment of Gratuity',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'FORM_16',
    documentName: 'Form No. 16',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    /* Six CALENDAR months from joining, not 180 days, and read in months on
       screen. A short target month is clamped rather than rolled over: somebody
       who joined on 31 August is due on 28 February. */
    documentCode: 'CONFIRMATION_LETTER',
    documentName: 'Confirmation Letter',
    isMandatory: true,
    deadlineValue: 6,
    deadlineUnit: DEADLINE_UNITS.MONTH,
  },
]

const BY_CODE: ReadonlyMap<string, ChecklistRule> = new Map(
  DOCUMENT_CHECKLIST.map((rule) => [rule.documentCode, rule]),
)

/**
 * What the checklist says about one document type, or nothing.
 *
 * Nothing means a type the database holds that this list does not - a document
 * added by hand, or one retired years ago. Such a type keeps whatever the
 * database says about it and is not on anybody's new checklist, which is the
 * safe reading: this list decides the documents it names and does not silently
 * take over the ones it does not.
 */
export function checklistRuleFor(documentCode: string): ChecklistRule | undefined {
  return BY_CODE.get(documentCode)
}

/** The codes this list covers, for the queries that have to name them. */
export const CHECKLIST_DOCUMENT_CODES: readonly string[] = DOCUMENT_CHECKLIST.map(
  (rule) => rule.documentCode,
)
