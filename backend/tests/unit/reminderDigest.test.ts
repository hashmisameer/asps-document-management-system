import { describe, expect, it } from 'vitest'
import { DEADLINE_STATE } from '@asps-dms/shared'
import { buildDigest, groupPending } from '../../src/services/reminderDigest.service.js'
import type { PendingDocumentRow } from '../../src/repositories/reminder.repository.js'

/**
 * The pending-documents digest.
 *
 * What is pinned here is what someone reading the email actually relies on: the
 * right employees, the right documents against each, worst first, and no email
 * at all when there is nothing outstanding.
 */

const TODAY = '2026-08-31'

function row(overrides: Partial<PendingDocumentRow> = {}): PendingDocumentRow {
  return {
    employeeId: 1,
    employeeCode: 'EMP001',
    employeeName: 'Ravi Kumar',
    documentName: 'Aadhaar Card',
    isMandatory: true,
    dueDate: '2026-08-20',
    ...overrides,
  }
}

describe('groupPending', () => {
  it('gathers each employee\'s documents under one entry', () => {
    const grouped = groupPending(
      [
        row({ documentName: 'Aadhaar Card' }),
        row({ documentName: 'PAN Card' }),
        row({ employeeId: 2, employeeCode: 'EMP002', employeeName: 'Anita Desai' }),
      ],
      { today: TODAY },
    )

    expect(grouped).toHaveLength(2)
    expect(grouped[0]?.documents.map((d) => d.documentName)).toEqual(['Aadhaar Card', 'PAN Card'])
  })

  it('leaves out a document whose date has not arrived', () => {
    // Otherwise every new employee's whole checklist arrives on day one and the
    // digest becomes a copy of the checklist that nobody reads.
    const grouped = groupPending([row({ dueDate: '2027-01-01' })], { today: TODAY })
    expect(grouped).toEqual([])
  })

  it('includes a not-yet-due document when asked to', () => {
    const grouped = groupPending([row({ dueDate: '2027-01-01' })], {
      today: TODAY,
      includeNotYetDue: true,
    })
    expect(grouped).toHaveLength(1)
  })

  it('keeps a document that has no deadline at all', () => {
    // It is genuinely outstanding. Dropping it would let an employee owe a
    // document that no reminder ever mentions.
    const grouped = groupPending([row({ dueDate: null })], { today: TODAY })
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.documents[0]?.state).toBe(DEADLINE_STATE.NOT_APPLICABLE)
  })

  it('puts the overdue employee first, and the overdue document first', () => {
    const grouped = groupPending(
      [
        row({ employeeId: 2, employeeCode: 'EMP002', dueDate: '2026-09-02' }),
        row({ employeeId: 1, employeeCode: 'EMP001', documentName: 'PAN Card', dueDate: '2026-09-01' }),
        row({ employeeId: 1, employeeCode: 'EMP001', documentName: 'Aadhaar Card', dueDate: '2026-08-01' }),
      ],
      { today: TODAY },
    )

    expect(grouped[0]?.employeeCode).toBe('EMP001')
    expect(grouped[0]?.documents[0]?.documentName).toBe('Aadhaar Card')
    expect(grouped[0]?.documents[0]?.state).toBe(DEADLINE_STATE.OVERDUE)
  })
})

describe('buildDigest', () => {
  it('names every employee and every pending document', () => {
    const digest = buildDigest(
      [
        row({ documentName: 'Aadhaar Card' }),
        row({ documentName: 'PAN Card' }),
        row({
          employeeId: 2,
          employeeCode: 'EMP002',
          employeeName: 'Anita Desai',
          documentName: 'Service Card',
          isMandatory: false,
        }),
      ],
      { today: TODAY },
    )

    expect(digest).not.toBeNull()
    for (const expected of ['EMP001', 'Ravi Kumar', 'Aadhaar Card', 'PAN Card', 'EMP002', 'Anita Desai', 'Service Card']) {
      expect(digest?.text).toContain(expected)
      expect(digest?.html).toContain(expected)
    }
    expect(digest?.employeeCount).toBe(2)
    expect(digest?.documentCount).toBe(3)
  })

  it('sends nothing when nothing is outstanding', () => {
    // A daily email saying all is well teaches people to delete it unread, and
    // the one that mattered goes with it.
    expect(buildDigest([], { today: TODAY })).toBeNull()
  })

  it('counts the overdue documents in the subject', () => {
    const digest = buildDigest(
      [row({ dueDate: '2026-08-01' }), row({ documentName: 'PAN Card', dueDate: '2026-09-02' })],
      { today: TODAY },
    )
    expect(digest?.overdueCount).toBe(1)
    expect(digest?.subject).toContain('1 overdue')
  })

  it('says one employee rather than 1 employees', () => {
    const digest = buildDigest([row()], { today: TODAY })
    expect(digest?.subject).toContain('1 employee with')
    expect(digest?.subject).not.toContain('employees')
  })

  it('marks a mandatory document as such', () => {
    const digest = buildDigest([row({ isMandatory: true })], { today: TODAY })
    expect(digest?.text).toContain('[mandatory]')
  })

  it('escapes a name that would otherwise be markup', () => {
    // Employee names come from a form. One containing a tag must not become one
    // in the email body.
    const digest = buildDigest([row({ employeeName: 'A <script>x</script> B' })], { today: TODAY })
    expect(digest?.html).not.toContain('<script>')
    expect(digest?.html).toContain('&lt;script&gt;')
  })

  it('says that it will keep coming', () => {
    const digest = buildDigest([row()], { today: TODAY })
    expect(digest?.text).toContain('repeats until the documents are uploaded')
  })
})
