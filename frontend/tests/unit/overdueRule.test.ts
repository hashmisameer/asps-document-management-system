import { describe, expect, it } from 'vitest'
import { DOCUMENT_CHECKLIST, tracksOverdue } from '@asps-dms/shared'

/**
 * Whether a type's report page offers 'Overdue only', shows days overdue and
 * badges a missed row Overdue - the one rule the page, its Excel export and
 * its printed list all read. A type can be late when it has a DEADLINE, not
 * when it is mandatory.
 */

const rule = (code: string) => {
  const found = DOCUMENT_CHECKLIST.find((type) => type.documentCode === code)
  if (!found) throw new Error(`the checklist has no ${code}`)
  return found
}

describe('tracksOverdue', () => {
  it('tracks overdue on ESIC and PF, which have a deadline - while they stay optional', () => {
    for (const code of ['ESIC_FORM', 'PF_FORM']) {
      expect(rule(code).isMandatory, `${code} stays optional`).toBe(false)
      expect(rule(code).deadlineValue, `${code} has a deadline`).toBe(12)
      expect(tracksOverdue(rule(code)), code).toBe(true)
    }
  })

  it('never tracks overdue on FNF, which has no deadline', () => {
    expect(rule('FNF').deadlineValue).toBeNull()
    expect(tracksOverdue(rule('FNF'))).toBe(false)
  })

  it('tracks overdue on every type with a deadline, and on none without one', () => {
    for (const type of DOCUMENT_CHECKLIST) {
      expect(tracksOverdue(type), type.documentCode).toBe(type.deadlineValue !== null)
    }
  })

  it('does not read a missing deadline as one', () => {
    // A value lost on its way to the browser arrives as undefined, not null.
    expect(tracksOverdue({ deadlineValue: undefined as unknown as null })).toBe(false)
  })
})
