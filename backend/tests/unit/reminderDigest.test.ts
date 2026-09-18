import { describe, expect, it } from 'vitest'
import {
  OVERDUE_SHEET_COLUMNS,
  buildDigest,
  buildOverdueSheet,
  overdueRows,
  overdueSheetFileName,
  previewSheet,
} from '../../src/services/reminderDigest.service.js'
import type { PendingDocumentRow } from '../../src/repositories/reminder.repository.js'
import { readXlsx, readZipEntries } from '../../src/utils/xlsx.js'

/**
 * The overdue-documents digest: a short email and the sheet attached to it.
 *
 * What is pinned here is what someone opening the email relies on: only what
 * is actually late, one row per late document with the employee repeated, the
 * columns the office asked for in the order they asked for them, codes with
 * their zeros, and no email at all when nothing is late.
 */

const TODAY = '2026-09-18'
const WHEN = new Date(2026, 8, 18, 9, 0, 0)

function row(overrides: Partial<PendingDocumentRow> = {}): PendingDocumentRow {
  return {
    employeeId: 1,
    employeeCode: '00005696',
    employeeName: 'Ravi Kumar',
    documentName: 'Aadhaar Card',
    isMandatory: true,
    dueDate: '2026-09-11',
    ...overrides,
  }
}

describe('overdueRows', () => {
  it('keeps only what is late, and nothing that is merely coming up', () => {
    const rows = overdueRows(
      [
        row({ documentName: 'Overdue', dueDate: '2026-09-17' }),
        row({ documentName: 'Due today', dueDate: '2026-09-18' }),
        row({ documentName: 'Due in 3 days', dueDate: '2026-09-21' }),
        row({ documentName: 'Not due', dueDate: '2027-01-01' }),
        row({ documentName: 'No deadline', dueDate: null }),
      ],
      { today: TODAY },
    )

    expect(rows.map((r) => r.documentName)).toEqual(['Overdue'])
  })

  it('makes one row per overdue document, repeating the employee on each', () => {
    const rows = overdueRows(
      [
        row({ documentName: 'Aadhaar Card' }),
        row({ documentName: 'PAN Card' }),
        row({ documentName: 'Bio Data Form' }),
      ],
      { today: TODAY },
    )

    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.employeeCode))).toEqual(new Set(['00005696']))
    expect(new Set(rows.map((r) => r.employeeName))).toEqual(new Set(['Ravi Kumar']))
  })

  it('counts whole days past the due date', () => {
    const rows = overdueRows(
      [row({ dueDate: '2026-09-17' }), row({ documentName: 'PAN Card', dueDate: '2026-08-18' })],
      { today: TODAY },
    )

    expect(rows.map((r) => [r.documentName, r.daysOverdue])).toEqual([
      ['PAN Card', 31],
      ['Aadhaar Card', 1],
    ])
  })

  it('orders by employee code, and within an employee the most overdue first', () => {
    const rows = overdueRows(
      [
        row({ employeeId: 2, employeeCode: '00005700', employeeName: 'B', dueDate: '2026-09-01' }),
        row({
          employeeId: 1,
          employeeCode: '00005696',
          documentName: 'PAN Card',
          dueDate: '2026-09-10',
        }),
        row({
          employeeId: 1,
          employeeCode: '00005696',
          documentName: 'Aadhaar Card',
          dueDate: '2026-08-01',
        }),
      ],
      { today: TODAY },
    )

    expect(rows.map((r) => `${r.employeeCode} ${r.documentName}`)).toEqual([
      '00005696 Aadhaar Card',
      '00005696 PAN Card',
      '00005700 Aadhaar Card',
    ])
  })
})

describe('the sheet', () => {
  it('has exactly the columns the office asked for, in that order', () => {
    expect(OVERDUE_SHEET_COLUMNS.map((column) => column.header)).toEqual([
      'employee_id',
      'employee_name',
      'documents_pending',
      'overdue_dates',
      'days of overdue',
    ])
  })

  it('reads back with the code intact, the date as the app shows it, and the days as a number', () => {
    const rows = overdueRows([row({ dueDate: '2026-09-11' })], { today: TODAY })
    const file = Buffer.from(buildOverdueSheet(rows, WHEN))

    expect(readXlsx(file)).toEqual([
      ['employee_id', 'employee_name', 'documents_pending', 'overdue_dates', 'days of overdue'],
      ['00005696', 'Ravi Kumar', 'Aadhaar Card', '11/09/2026', '7'],
    ])

    // Text cells for everything but the day count, which is a number so Excel
    // sorts 9 before 10. The code is text BECAUSE the cell says so - not
    // because Excel guessed right.
    const sheet = readZipEntries(file).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''
    expect(sheet).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">00005696</t></is></c>',
    )
    expect(sheet).toContain(
      '<c r="D2" t="inlineStr"><is><t xml:space="preserve">11/09/2026</t></is></c>',
    )
    expect(sheet).toContain('<c r="E2"><v>7</v></c>')
    expect(sheet).not.toContain('<v>5696</v>')
  })

  it('carries a name with markup in it as plain text', () => {
    const rows = overdueRows([row({ employeeName: 'A <b>&</b> B' })], { today: TODAY })
    const file = Buffer.from(buildOverdueSheet(rows, WHEN))

    expect(readXlsx(file)[1]?.[1]).toBe('A <b>&</b> B')
  })

  it('is named for the day it was made, on the server calendar', () => {
    expect(overdueSheetFileName(WHEN)).toBe('asps-dms-overdue-documents-2026-09-18.xlsx')
    expect(overdueSheetFileName(new Date(2026, 0, 5, 23, 59))).toBe(
      'asps-dms-overdue-documents-2026-01-05.xlsx',
    )
  })
})

describe('buildDigest', () => {
  it('sends nothing when nothing is overdue, even with documents pending', () => {
    // A daily email saying all is well teaches people to delete it unread, and
    // the one that mattered goes with it. Pending but not late is such a day.
    expect(buildDigest([], { today: TODAY })).toBeNull()
    expect(
      buildDigest([row({ dueDate: '2026-09-18' }), row({ dueDate: '2026-09-25' })], {
        today: TODAY,
      }),
    ).toBeNull()
  })

  it('says the two numbers and that the list is attached, and no more', () => {
    const digest = buildDigest(
      [
        row({ documentName: 'Aadhaar Card' }),
        row({ documentName: 'PAN Card' }),
        row({ employeeId: 2, employeeCode: '00005700', employeeName: 'Anita Desai' }),
        // Pending, not late: counted nowhere.
        row({
          employeeId: 3,
          employeeCode: '00005701',
          employeeName: 'Not Late',
          dueDate: '2026-09-30',
        }),
      ],
      { today: TODAY, when: WHEN },
    )

    expect(digest?.employeeCount).toBe(2)
    expect(digest?.overdueCount).toBe(3)
    expect(digest?.subject).toBe('ASPS-DMS: 2 employees with 3 overdue documents')
    expect(digest?.text).toContain('2 employees have 3 overdue documents.')
    expect(digest?.text).toContain('attached as asps-dms-overdue-documents-2026-09-18.xlsx')
    expect(digest?.text).toContain('repeats until the documents are uploaded')
    expect(digest?.html).toContain('asps-dms-overdue-documents-2026-09-18.xlsx')

    // The list has moved into the sheet: no names in the body.
    for (const name of ['Ravi Kumar', 'Anita Desai', 'Aadhaar Card', 'Not Late']) {
      expect(digest?.text).not.toContain(name)
      expect(digest?.html).not.toContain(name)
    }
  })

  it('counts an employee once however many documents they are late with', () => {
    const digest = buildDigest(
      [row({ documentName: 'Aadhaar Card' }), row({ documentName: 'PAN Card' })],
      { today: TODAY },
    )
    expect(digest?.subject).toBe('ASPS-DMS: 1 employee with 2 overdue documents')
  })

  it('says one document rather than 1 documents', () => {
    expect(buildDigest([row()], { today: TODAY })?.subject).toBe(
      'ASPS-DMS: 1 employee with 1 overdue document',
    )
  })

  it('attaches the sheet with every overdue row and says how many', () => {
    const digest = buildDigest(
      [row({ documentName: 'Aadhaar Card' }), row({ documentName: 'PAN Card' })],
      { today: TODAY, when: WHEN },
    )

    expect(digest?.attachment.fileName).toBe('asps-dms-overdue-documents-2026-09-18.xlsx')
    expect(digest?.attachment.rowCount).toBe(2)
    expect(readXlsx(Buffer.from(digest?.attachment.bytes ?? new Uint8Array()))).toHaveLength(3)
    expect(digest?.rows).toHaveLength(2)
  })
})

describe('previewSheet', () => {
  it('prints the headings and the first rows as columns, and says what was left out', () => {
    const rows = overdueRows(
      Array.from({ length: 25 }, (_, i) =>
        row({ employeeId: i, employeeCode: String(i).padStart(8, '0'), dueDate: '2026-09-11' }),
      ),
      { today: TODAY },
    )

    const lines = previewSheet(rows, 20)

    expect(lines[0]).toBe(
      'employee_id  employee_name  documents_pending  overdue_dates  days of overdue',
    )
    expect(lines[1]).toBe('00000000     Ravi Kumar     Aadhaar Card       11/09/2026     7')
    expect(lines).toHaveLength(22)
    expect(lines[21]).toBe('... and 5 more row(s)')
  })

  it('says nothing about rows left out when none were', () => {
    const lines = previewSheet(overdueRows([row()], { today: TODAY }))
    expect(lines).toHaveLength(2)
  })
})
