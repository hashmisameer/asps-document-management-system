import { computeDueDate, type DocumentType } from '@asps-dms/shared'
import { toDisplayDate } from '../../lib/format.js'

/**
 * What the deadline column says for one document while an employee is entered.
 *
 * Three different answers, and confusing them is the bug this exists to stop:
 *
 *   ''             no joining date yet, so there is nothing to work out from.
 *                  BLANK, not 'No deadline' - that would say the wrong thing
 *                  about a document that has one.
 *   'No deadline'  this document never falls due. The identity cards and the
 *                  two statutory forms are chased by hand.
 *   a date         what will be written onto the row when the record is made.
 *
 * Pure, and called on every render: typing a joining date fills the whole
 * column in as the last digit lands, and correcting it moves every row.
 */
export function deadlineText(type: DocumentType, joiningDate: string): string {
  // A half-typed date gives no deadlines rather than nonsense ones.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) return ''

  const dueDate = computeDueDate(joiningDate, type.deadlineValue, type.deadlineUnit)
  return dueDate ? toDisplayDate(dueDate) : 'No deadline'
}
