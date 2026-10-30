import { DEADLINE_UNITS, type DeadlineUnit } from './deadlines.js'

/**
 * The checklist: every document the company collects, and what it expects.
 *
 * THE ONE PLACE THIS IS DECIDED. It was configurable - a Settings screen wrote
 * it into dbo.DocumentTypes - and the office asked for it back in code: the list
 * has been the same documents for years, and a screen that can change it is a
 * screen somebody changes by accident on a Friday.
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
 * EVERY DOCUMENT IT CHASES HAS A DEADLINE, since 2026-09-17. Four are due in
 * a week, four in twelve days, and the confirmation letter six calendar months
 * after joining. The identity cards and the two statutory forms had none, and
 * were chased by hand; the office asked for dates on them so they are chased
 * like the rest. The one with none is FNF, which is not chased at all - see
 * below.
 *
 * FNF - THE FULL AND FINAL SETTLEMENT (2026-10-30, migration 0041; named
 * 'FNF', as HR calls it, by 0042) is a leaver's
 * document, and it is the one that works differently. It STARTS SET ASIDE on
 * every checklist (startsNotRequired), so nothing counts it until HR marks it
 * required for the employee whose FNF has arrived. And it is COLLECTED AFTER
 * LEAVING (collectedAfterLeaving): it can be marked required and uploaded for
 * somebody who has already gone, and once it is, the documents list and the
 * reports show it - see LISTED_DOCUMENT in employeeScope.ts.
 *
 * CHANGING SOMETHING HERE DOES NOT MOVE ANYBODY'S EXISTING DEADLINE. A due date
 * is written onto the employee's row when they are created, from this list as it
 * stood that day, and it stays there. Shortening a deadline would otherwise make
 * a hundred people overdue between one deployment and the next, for a document
 * nobody had been late with the day before. When the office does want existing
 * rows moved, that is a migration - 0023 and 0034 are the two that have - and
 * only rows with nothing attached are moved; a document that has arrived keeps
 * the date that applied to it.
 */

/** FNF, the full and final settlement: the code its report page and its rules are keyed by. */
export const FNF_DOCUMENT_CODE = 'FNF'

export interface ChecklistRule {
  /** The code that identifies this document for ever. */
  documentCode: string
  documentName: string
  isMandatory: boolean
  /** Null together with the unit: a document that is collected but never due. */
  deadlineValue: number | null
  deadlineUnit: DeadlineUnit | null
  /**
   * Created set aside on every new checklist - 'Not required' until HR marks it
   * required for the employee it applies to. Read ONLY when a checklist is
   * created, never by a count: the counts read the row's NotRequiredAt, as they
   * do for a document HR set aside by hand. The row records no person, because
   * none decided (0041). Absent means false.
   */
  startsNotRequired?: boolean
  /**
   * Collected from somebody who has LEFT. Everything else stops at the last
   * working day - a leaver cannot bring a document in - so the checklist hides
   * upload and 'Mark as required' for a leaver, and the lists leave leavers out.
   * A type with this set is the exception, in the checklist and in the lists
   * that show documents (documents list, reports), but not in the ones that
   * chase them (dashboard, overdue, the daily reminder). Absent means false.
   */
  collectedAfterLeaving?: boolean
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
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'PAN_CARD',
    documentName: 'PAN Card',
    isMandatory: true,
    deadlineValue: 7,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    /* Optional - filed with the government, not collected from the employee -
       and dated all the same, so it is chased. */
    documentCode: 'PF_FORM',
    documentName: 'PF Form / Form 11',
    isMandatory: false,
    deadlineValue: 12,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'ESIC_FORM',
    documentName: 'ESIC Form',
    isMandatory: false,
    deadlineValue: 12,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'GRATUITY_FORM',
    documentName: 'Payment of Gratuity',
    isMandatory: true,
    deadlineValue: 12,
    deadlineUnit: DEADLINE_UNITS.DAY,
  },
  {
    documentCode: 'FORM_16',
    documentName: 'Form No. 16',
    isMandatory: true,
    deadlineValue: 12,
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
  {
    /* Last. Whatever management holds for somebody who has left: set aside on
       every checklist until it arrives, never dated, never chased. */
    documentCode: FNF_DOCUMENT_CODE,
    documentName: 'FNF',
    isMandatory: false,
    deadlineValue: null,
    deadlineUnit: null,
    startsNotRequired: true,
    collectedAfterLeaving: true,
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

/** The types collected from somebody who has left: FNF. For the SQL that has to name them. */
export const COLLECTED_AFTER_LEAVING_CODES: readonly string[] = DOCUMENT_CHECKLIST.filter(
  (rule) => rule.collectedAfterLeaving === true,
).map((rule) => rule.documentCode)
