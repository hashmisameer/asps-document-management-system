import { IDENTITY_CARD_DOCUMENT_CODES, parseDateOnly, todayDateOnly } from '@asps-dms/shared'
import { sql } from '../database/pool.js'

/**
 * Who this system counts.
 *
 * ONE definition, used by every count, list, report and email. It was written
 * out by hand in a dozen queries across four repositories, and that is a rule
 * that survives exactly as long as everybody remembers it: the next screen is
 * the one where somebody forgets, and nothing fails - the number is simply
 * wrong, and wrong in the direction that makes the office chase a form from
 * somebody who left last March.
 *
 * A COUNTABLE EMPLOYEE is one who is on the books and has not gone:
 *
 *   IsActive = 1        the record has not been archived. An archived record is
 *                       one the office has struck out - a duplicate, or an entry
 *                       made in error - and was never a person who worked here.
 *
 *   not past their last working day. Somebody who has left cannot bring a
 *                       document in, so their missing form is not a gap anybody
 *                       can close. Counting it drags every percentage down for
 *                       ever and puts a name on a chase list that nobody can act
 *                       on.
 *
 * Note that an employee who has RESIGNED but is working their notice is still
 * countable, and should be: they are still here, still paid, and still owe their
 * paperwork. It is the last working DAY that moves them out, not the notice.
 *
 * THE TWO EXCEPTIONS, both on the dashboard and both deliberate: the 'Total
 * employees' card counts active and left together (IsActive = 1), and the 'Left
 * this year' card counts leavers. Everywhere else, this.
 *
 * Every fragment here names the employee table `e` and reads a bound `@today`.
 * Bind it with `bindToday`.
 */
export const COUNTABLE_EMPLOYEE =
  'e.IsActive = 1 AND (e.LastWorkingDate IS NULL OR e.LastWorkingDate >= @today)'

/**
 * The other half of the same line: whether an employee has actually gone yet,
 * worked out at read time.
 *
 * The stored EmploymentStatus records what was DECIDED; this says what is true
 * TODAY. An exit is almost always recorded in advance - somebody resigns on the
 * 1st to leave on the 30th - so the stored column reads 'ACTIVE' for the whole
 * notice period and would have to change on one particular morning. Relying on
 * something to run that morning means that on the day nothing runs, a person
 * who left a week ago is still on the headcount and still in the reminder
 * emails.
 *
 * Derived instead, the same way deadline state is: correct the moment it is
 * looked at, with no job to schedule and no stale flag to reconcile.
 */
export const EFFECTIVE_LEFT = '(e.LastWorkingDate IS NOT NULL AND e.LastWorkingDate < @today)'

/**
 * The document rows those employees own.
 *
 * `d.IsActive = 1` excludes the superseded row behind a replacement, so a
 * document that was uploaded twice is counted once.
 */
export const COUNTABLE_DOCUMENT = `d.IsActive = 1 AND ${COUNTABLE_EMPLOYEE}`

/**
 * The two identity cards, as an IN list.
 *
 * Built from the shared constant rather than typed out again: 'Missing an ID
 * card' has to mean the same two documents on the dashboard and in the list it
 * opens, and it used to mean 'any mandatory document' - which was those two
 * only for as long as they were the only mandatory ones. Eight of the ten are
 * mandatory now.
 */
export const IDENTITY_CARD_CODES_SQL = IDENTITY_CARD_DOCUMENT_CODES.map(
  (code) => `'${code}'`,
).join(', ')

/**
 * Binds the `@today` every fragment above reads.
 *
 * One date for the whole request, so a query that runs across midnight cannot
 * answer two different questions in its two halves.
 */
export function bindToday(request: sql.Request, today: string = todayDateOnly()): sql.Request {
  return request.input('today', sql.Date, parseDateOnly(today))
}
