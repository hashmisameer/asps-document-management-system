import type { DashboardSummary } from './api.js'

/**
 * What each dashboard tile says, and where it goes.
 *
 * Kept apart from the page so the two things that can go wrong here are
 * testable without rendering anything:
 *
 *   THE NUMBER. Every tile opens a list, and the list must hold exactly as many
 *   rows as the tile claims. That only holds if the tile's value and its link's
 *   filters come from the same place - so they are written on the same line,
 *   here, rather than a number in one part of the page and a URL in another.
 *
 *   WHAT IS COUNTED. The document tiles count checklist ROWS and the employee
 *   tiles count PEOPLE. 'Still to come 57' is fifty-seven documents spread over
 *   fewer employees than that, which is why those tiles open /documents and not
 *   /employees.
 */

export type TileTone = 'neutral' | 'good' | 'warn' | 'bad'

export interface DashboardTile {
  key: string
  label: string
  value: number
  hint?: string
  tone: TileTone
  /** Every tile is a link. There is no such thing as a number nobody can open. */
  to: string
}

/** Bad when there is something to do, good when there is not. */
const alarm = (value: number, tone: TileTone = 'bad'): TileTone => (value > 0 ? tone : 'good')

export function needsAttentionTiles(summary: DashboardSummary): DashboardTile[] {
  return [
    {
      key: 'overdue',
      label: 'Overdue documents',
      value: summary.documents.overdue,
      hint: 'Past their date and still not in',
      tone: alarm(summary.documents.overdue),
      to: '/documents?state=overdue',
    },
    {
      key: 'missingIdCard',
      // Mandatory means the two identity cards, which is why this tile and the
      // missingIdCard filter are the same question.
      label: 'Missing an ID card',
      value: summary.employeesMissingMandatory,
      hint: 'Employees without Aadhaar or PAN',
      tone: alarm(summary.employeesMissingMandatory),
      to: '/employees?missingIdCard=true',
    },
    {
      key: 'dueSoon',
      label: 'Due in the next 7 days',
      value: summary.documents.dueSoon,
      hint: 'Deadlines coming up, including today',
      tone: alarm(summary.documents.dueSoon, 'warn'),
      to: '/documents?state=dueSoon',
    },
    {
      /*
       * The employees who have never signed on the pad.
       *
       * This used to be two tiles saying the same thing - an 'Awaiting
       * signature' here that counted DOCUMENTS waiting on a signature, and a
       * 'No signature on file' among the documents that counted PEOPLE. The
       * office read them as one fact and could not tell why the numbers
       * differed. This is the one that can be acted on: until somebody has
       * signed once, nothing of theirs can be signed at all.
       */
      key: 'withoutSignature',
      label: 'Pending employee signature',
      value: summary.signatures.employeesWithoutSignature,
      hint: 'Employees who have not signed on the pad yet',
      tone: alarm(summary.signatures.employeesWithoutSignature, 'warn'),
      to: '/employees?withoutSignature=true',
    },
  ]
}

export function employeeTiles(summary: DashboardSummary): DashboardTile[] {
  const { employees } = summary

  return [
    {
      /*
       * Everybody the company has employed, and the tile people quote.
       *
       * First, because it is the number somebody reads before the breakdown
       * beside it - and it is exactly the two tiles after it added together.
       *
       * Archived records are not in it. They are not people who worked here;
       * they are the entries the office has struck out - mistakes and
       * duplicates - and the hint says so on the card rather than leaving
       * anybody to work out which of three numbers this one is.
       */
      key: 'activeAndLeft',
      label: 'Total employees',
      value: employees.activeAndLeft,
      hint: 'Active and left, excluding archived',
      tone: 'neutral',
      // 'all' is active and left together; archived stays out because
      // includeArchived is off, which leaves exactly IsActive = 1.
      to: '/employees?status=all',
    },
    {
      key: 'active',
      label: 'Active',
      value: employees.total,
      hint: `${employees.joinedLast30Days} joined in the last 30 days`,
      tone: 'neutral',
      to: '/employees?status=active',
    },
    {
      /*
       * Left is about the person and archived is about the record, so they are
       * counted separately and neither is inside 'Active'.
       *
       * Archived records are out of this count, as they are out of every other
       * count on this page - so the link does not ask for them either.
       */
      key: 'leftThisYear',
      label: 'Left this year',
      value: employees.leftThisYear,
      hint: `${employees.left} have left in total`,
      tone: 'neutral',
      to: '/employees?status=left&leftThisYear=true',
    },
    {
      // 'status=all' because an archived record may belong to somebody who has
      // left, and the tile counts those too.
      key: 'archived',
      label: 'Archived',
      value: employees.archived,
      hint: 'Records the office has finished with',
      tone: 'neutral',
      to: '/employees?archivedOnly=true&status=all',
    },
  ]
}

/** The gender split: a label, a count, and a list to open. */
export interface GenderSlice {
  key: string
  label: string
  value: number
  to: string
  /** The colour of its share of the bar and of its dot in the key. */
  className: string
}

export function genderSlices(summary: DashboardSummary): GenderSlice[] {
  const { employees } = summary

  return [
    {
      key: 'Male',
      label: 'Men',
      value: employees.male,
      to: '/employees?gender=Male',
      className: 'bg-brand-600',
    },
    {
      key: 'Female',
      label: 'Women',
      value: employees.female,
      to: '/employees?gender=Female',
      className: 'bg-status-review',
    },
    {
      key: 'Other',
      label: 'Other',
      value: employees.other,
      to: '/employees?gender=Other',
      className: 'bg-status-verified',
    },
    {
      /* Shown rather than folded into a side, and openable like the rest:
         guessing would put a number on the screen somebody may act on, and
         'nobody has recorded this yet' is a list worth working through. */
      key: 'notRecorded',
      label: 'Not recorded',
      value: employees.notRecorded,
      to: '/employees?gender=notRecorded',
      className: 'bg-slate-300',
    },
  ]
}

/**
 * Where each employee's checklist has got to.
 *
 * EMPLOYEES, not document rows. This section used to count rows - 'On the
 * checklists 60, Received 3, Still to come 57' - and none of those is a number
 * anybody can act on: 57 outstanding rows might be five people or fifty, and
 * the office chases people rather than rows.
 *
 * Two cards, and they add up to the active staff, so there is nothing to
 * reconcile: everybody is in exactly one of them.
 */
export function documentTiles(summary: DashboardSummary): DashboardTile[] {
  const { complete, incomplete } = summary.checklists
  const active = summary.employees.total
  const of = (value: number): string =>
    `${value} of ${active} ${active === 1 ? 'employee' : 'employees'}`

  return [
    {
      key: 'complete',
      label: 'Complete',
      value: complete,
      hint: of(complete),
      tone: 'good',
      to: '/employees?checklist=complete',
    },
    {
      /* Sorted with the most outstanding first, because that is the order
         somebody working through this list wants to read it in - and the row
         itself says how many are left, so the list can be worked from without
         opening anybody. */
      key: 'incomplete',
      label: 'Incomplete',
      value: incomplete,
      hint: of(incomplete),
      tone: alarm(incomplete, 'warn'),
      to: '/employees?checklist=incomplete&sortBy=documentsPending&sortDir=desc',
    },
  ]
}
