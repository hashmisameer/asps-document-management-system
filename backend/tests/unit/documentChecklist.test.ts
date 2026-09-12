import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEADLINE_STATE,
  DOCUMENT_CHECKLIST,
  DOCUMENT_STATUS,
  computeDueDate,
  deriveDeadline,
  isIdentityCard,
  type DeadlineUnit,
} from '@asps-dms/shared'

/**
 * The checklist the office keeps, and what it does to an employee's dates.
 *
 * The list is DOCUMENT_CHECKLIST, in code - the office asked for it there
 * rather than in a screen, because it has been the same ten documents for years
 * and a screen that can change it is a screen somebody changes by accident.
 *
 * Two things are held together here.
 *
 * THE DATABASE AGREES WITH THE CODE. The application lays the constant over
 * every row it reads, but SQL cannot: the reports filter on IsMandatory in the
 * database. So the seed - what a fresh database starts from - is parsed and
 * compared against the constant, line by line. Editing one and not the other
 * fails here rather than in a report six weeks later.
 *
 * AND THE DATES IT PRODUCES, for somebody who joined on a given day.
 */

const seed = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../database/seeds/0002_document_types.sql',
  ),
  'utf8',
)

interface SeededType {
  documentCode: string
  documentName: string
  isMandatory: boolean
  deadlineValue: number | null
  deadlineUnit: DeadlineUnit | null
}

/** The VALUES rows of the seed's MERGE, as the application would read them. */
function seededTypes(): SeededType[] {
  const pattern =
    /\('([A-Z0-9_]+)',\s*N'((?:[^']|'')*)',\s*([01]),\s*[01],\s*(NULL|\d+),\s*(NULL|'[A-Z]+'),\s*\d+,/g

  return [...seed.matchAll(pattern)].map((match) => ({
    documentCode: match[1] ?? '',
    documentName: (match[2] ?? '').replace(/''/g, "'"),
    isMandatory: match[3] === '1',
    deadlineValue: match[4] === 'NULL' ? null : Number(match[4]),
    deadlineUnit:
      match[5] === 'NULL' ? null : ((match[5] ?? '').replace(/'/g, '') as DeadlineUnit),
  }))
}

const types = seededTypes()

/** The seed, as the checklist constant would state it. */
const seededRules = types.map((type) => ({
  documentCode: type.documentCode,
  documentName: type.documentName,
  isMandatory: type.isMandatory,
  deadlineValue: type.deadlineValue,
  deadlineUnit: type.deadlineUnit,
}))
const byCode = (code: string): SeededType => {
  const type = types.find((candidate) => candidate.documentCode === code)
  if (!type) throw new Error(`the seed has no ${code}`)
  return type
}

describe('the document list', () => {
  it('is what the code says it is, down to the last flag', () => {
    // The one assertion that keeps a fresh database and the running application
    // describing the same checklist.
    expect(seededRules).toEqual(
      DOCUMENT_CHECKLIST.map((rule) => ({
        documentCode: rule.documentCode,
        documentName: rule.documentName,
        isMandatory: rule.isMandatory,
        deadlineValue: rule.deadlineValue,
        deadlineUnit: rule.deadlineUnit,
      })),
    )
  })

  it('is the nine the office keeps, and nothing else', () => {
    expect(types.map((type) => type.documentName)).toEqual([
      'Appointment Letter',
      'Bio Data Form',
      'Aadhaar Card',
      'PAN Card',
      'PF Form',
      'ESIC Form',
      'Payment of Gratuity',
      'Form No. 16',
      'Confirmation Letter',
    ])
  })

  it('has no Service Card, which the office retired in 0029', () => {
    // Collected for years and retired on 2026-09-12. A fresh database must
    // never grow it back.
    expect(types.some((type) => type.documentCode === 'SERVICE_CARD')).toBe(false)
  })

  it('has no Bank Proof, which was never on the company list', () => {
    // Added to one database by hand and taken off in 0024. A fresh database
    // must never grow it back.
    const looksLikeBankProof = (text: string): boolean =>
      text.replace(/\s/g, '').toUpperCase().includes('BANKPROOF')

    expect(types.some((type) => looksLikeBankProof(type.documentName))).toBe(false)
    expect(types.some((type) => looksLikeBankProof(type.documentCode))).toBe(false)
  })

  it('collects eight and leaves the two statutory forms optional', () => {
    const optional = types.filter((type) => !type.isMandatory).map((type) => type.documentCode)

    // PF and ESIC are filed with the government rather than collected from the
    // employee, so an employee is not incomplete for want of them.
    expect(optional).toEqual(['PF_FORM', 'ESIC_FORM'])
  })

  it('gives a deadline only to the documents that are chased by date', () => {
    const withoutDeadline = types
      .filter((type) => type.deadlineValue === null)
      .map((type) => type.documentCode)

    expect(withoutDeadline).toEqual(['AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM'])
    // Both halves or neither: a value with no unit is not a deadline.
    for (const type of types) {
      expect(type.deadlineValue === null).toBe(type.deadlineUnit === null)
    }
  })

  it('knows the two identity cards by their code', () => {
    // Not by the mandatory flag, which now covers eight of the ten.
    const cards = types.filter((type) => isIdentityCard(type.documentCode))
    expect(cards.map((type) => type.documentCode)).toEqual(['AADHAAR_CARD', 'PAN_CARD'])
  })
})

describe('the dates a new employee is given', () => {
  const JOINED = '2026-09-01'

  /** Every deadline, worked out the way employee creation works it out. */
  const dueDates = new Map(
    types.map((type) => [
      type.documentCode,
      computeDueDate(JOINED, type.deadlineValue, type.deadlineUnit),
    ]),
  )

  it('fills every one of them in from the joining date', () => {
    // Nobody types these. Seven days for the four collected on the way in.
    for (const code of [
      'APPOINTMENT_LETTER',
      'BIO_DATA',
      'GRATUITY_FORM',
      'FORM_16',
    ]) {
      expect(dueDates.get(code), code).toBe('2026-09-08')
    }
  })

  it('gives the confirmation letter six calendar months, not 180 days', () => {
    expect(dueDates.get('CONFIRMATION_LETTER')).toBe('2027-03-01')
  })

  it('lands on the end of a short month rather than rolling into the next', () => {
    // 31 August plus six months. February has no 31st, and the answer is the
    // last day of February rather than the 3rd of March.
    expect(computeDueDate('2026-08-31', 6, 'MONTH')).toBe('2027-02-28')
    // And the same in a leap year.
    expect(computeDueDate('2027-08-31', 6, 'MONTH')).toBe('2028-02-29')
  })

  it('leaves the four without a deadline with no date at all', () => {
    for (const code of ['AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM']) {
      expect(dueDates.get(code), code).toBeNull()
    }
  })
})

describe('what the checklist says about each row', () => {
  const deadlineFor = (code: string, today: string, dueDate: string | null) =>
    deriveDeadline(dueDate, DOCUMENT_STATUS.PENDING, {
      today,
      deadlineUnit: byCode(code).deadlineUnit,
    })

  it("says 'No deadline' for the cards and the statutory forms, for ever", () => {
    for (const code of ['AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM']) {
      // Ten years after joining, still not late: these are chased by hand.
      const deadline = deadlineFor(code, '2036-09-01', null)

      expect(deadline.label, code).toBe('No deadline')
      expect(deadline.state, code).toBe(DEADLINE_STATE.NOT_APPLICABLE)
      expect(deadline.state, code).not.toBe(DEADLINE_STATE.OVERDUE)
    }
  })

  it('counts the confirmation letter in months', () => {
    // Joined 1 September, due 1 March. Read on 1 October: five months to go.
    expect(deadlineFor('CONFIRMATION_LETTER', '2026-10-01', '2027-03-01').label).toBe(
      'Due in 5 months',
    )
    expect(deadlineFor('CONFIRMATION_LETTER', '2026-09-01', '2027-03-01').label).toBe(
      'Due in 6 months',
    )
  })

  it('says how many months late the confirmation letter is', () => {
    expect(deadlineFor('CONFIRMATION_LETTER', '2027-05-01', '2027-03-01').label).toBe(
      'Overdue by 2 months',
    )
  })

  it('drops to days for the confirmation letter once under a month', () => {
    // 'Due in 0 months' says nothing to somebody deciding whether to chase it
    // this week, which is exactly when it is chased.
    expect(deadlineFor('CONFIRMATION_LETTER', '2027-02-20', '2027-03-01').label).toBe(
      'Due in 9 days',
    )
  })

  it('counts every other document in days', () => {
    expect(deadlineFor('GRATUITY_FORM', '2026-09-01', '2026-09-08').label).toBe('Due in 7 days')
    expect(deadlineFor('FORM_16', '2026-09-20', '2026-09-08').label).toBe('Overdue by 12 days')
    expect(deadlineFor('BIO_DATA', '2026-09-08', '2026-09-08').label).toBe('Due today')
  })
})
