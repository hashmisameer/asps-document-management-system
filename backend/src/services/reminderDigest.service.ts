import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  deriveDeadline,
  toXlsx,
  type XlsxColumn,
} from '@asps-dms/shared'
import type { PendingDocumentRow } from '../repositories/reminder.repository.js'
import { fileNameDate, formatDate } from '../utils/pdfDraw.js'

/**
 * Building the overdue-documents digest: a short email and a spreadsheet.
 *
 * One email, to several addresses, saying how many employees have how many
 * overdue documents, with the list attached as an .xlsx. It goes out again on
 * every run until the files are uploaded - that is the point of it, and it is
 * why the digest is rebuilt from the current state each time rather than
 * remembering what it said yesterday. Nothing is stored about a reminder
 * having been sent, so there is no state to drift out of step with the
 * checklist.
 *
 * THE LIST IS THE ATTACHMENT, NOT THE BODY. It used to be the body: every
 * employee and every document, in a table. With 467 employees and 491 overdue
 * documents that table was unreadable, and what the office wanted was
 * something to sort and filter. The email now says the two numbers and the
 * sheet carries the rows.
 *
 * OVERDUE ONLY, since 2026-09-18. The old digest also listed documents due
 * today or within the week, and - through a flag that only ever dropped the
 * ones more than a week away - could not be told not to. A reminder is about
 * something that is late; what is coming up is on the dashboard.
 *
 * This module is pure: rows in, subject, body and bytes out. Reading the
 * database and talking to a mail server happen elsewhere, so the wording, the
 * ordering and the columns - the parts that are wrong in ways a person
 * notices - can be tested against plain data with no SMTP server and no clock.
 */

/** One overdue document: one row of the sheet. */
export interface OverdueRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  /** Null for an employee whose department has never been recorded. */
  department: string | null
  documentName: string
  /** 'YYYY-MM-DD'. Always present - a document with no date cannot be late. */
  dueDate: string
  /** Whole days past the due date. At least 1. */
  daysOverdue: number
}

export interface DigestAttachment {
  fileName: string
  bytes: Uint8Array
  rowCount: number
}

export interface Digest {
  subject: string
  text: string
  html: string
  /** Employees with at least one overdue document. */
  employeeCount: number
  overdueCount: number
  attachment: DigestAttachment
  /** The sheet's rows, in sheet order, for a dry run to show. */
  rows: OverdueRow[]
}

export interface DigestOptions {
  /** Date-only, for testing. Defaults to today. */
  today?: string
  /** The moment the sheet is produced, for its file name. Defaults to now. */
  when?: Date
}

/**
 * The overdue documents, one row each, in the order the sheet has them.
 *
 * By employee code and then most overdue first, so somebody reading down the
 * sheet without sorting it sees each employee's rows together, worst on top.
 * An employee with three overdue documents is three rows, each repeating the
 * code and the name: the sheet is for sorting and filtering, and a merged or
 * blank cell is what stops that working.
 *
 * Only OVERDUE. Due today, due this week, not due yet and no deadline at all
 * are all left out - none of them is late, and the reminder is about what is.
 */
export function overdueRows(
  rows: readonly PendingDocumentRow[],
  options: DigestOptions = {},
): OverdueRow[] {
  const overdue: OverdueRow[] = []

  for (const row of rows) {
    // Status is Pending by definition here - these rows have no file - so the
    // deadline is derived against that rather than against a stored status
    // this query does not read.
    const deadline = deriveDeadline(row.dueDate, DOCUMENT_STATUS.PENDING, {
      ...(options.today ? { today: options.today } : {}),
    })
    if (deadline.state !== DEADLINE_STATE.OVERDUE || row.dueDate === null) continue

    overdue.push({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      department: row.department,
      documentName: row.documentName,
      dueDate: row.dueDate,
      daysOverdue: -(deadline.daysRemaining ?? 0),
    })
  }

  return overdue.sort(
    (a, b) =>
      a.employeeCode.localeCompare(b.employeeCode) ||
      b.daysOverdue - a.daysOverdue ||
      a.documentName.localeCompare(b.documentName),
  )
}

/**
 * The sheet's columns, in the order and with the headings the office asked
 * for, on 2026-09-18.
 *
 * Every column is TEXT except the day count. Employee codes are digit strings
 * with leading zeros - 00005696 - and a code written as a number is a code
 * with its zeros gone. The day count is a genuine number, written as one so
 * Excel sorts 9 before 10 rather than after it.
 */
export const OVERDUE_SHEET_COLUMNS: readonly XlsxColumn<OverdueRow>[] = [
  { header: 'employee_id', value: (row) => row.employeeCode, kind: 'text', width: 14 },
  { header: 'employee_name', value: (row) => row.employeeName, kind: 'text', width: 32 },
  /* Empty, never a dash, for somebody whose department is not recorded: this
     column exists to be sorted and filtered on, and a dash is a value Excel
     groups with the real ones. */
  { header: 'department', value: (row) => row.department ?? '', kind: 'text', width: 22 },
  { header: 'documents_pending', value: (row) => row.documentName, kind: 'text', width: 26 },
  { header: 'overdue_dates', value: (row) => formatDate(row.dueDate), kind: 'text', width: 14 },
  { header: 'days of overdue', value: (row) => row.daysOverdue, kind: 'number', width: 16 },
]

/** 'asps-dms-overdue-documents-2026-09-18.xlsx', dated on the server's calendar. */
export function overdueSheetFileName(at: Date): string {
  return `asps-dms-overdue-documents-${fileNameDate(at)}.xlsx`
}

export function buildOverdueSheet(rows: readonly OverdueRow[], when: Date): Uint8Array {
  return toXlsx(rows, OVERDUE_SHEET_COLUMNS, 'Overdue', when)
}

/**
 * The sheet's first rows as lines of text, for a dry run on the console.
 *
 * Read through the same column definitions the sheet is written with, so what
 * is printed is what would be attached - the same headings, in the same order,
 * the dates formatted the same way. Enough rows to see it is right, not all of
 * them; the last line says how many were left out.
 */
export function previewSheet(rows: readonly OverdueRow[], limit = 20): string[] {
  const shown = rows.slice(0, limit)
  const cells = [
    OVERDUE_SHEET_COLUMNS.map((column) => column.header),
    ...shown.map((row) => OVERDUE_SHEET_COLUMNS.map((column) => String(column.value(row)))),
  ]
  const widths = OVERDUE_SHEET_COLUMNS.map((_, c) =>
    Math.max(...cells.map((line) => line[c]?.length ?? 0)),
  )
  const lines = cells.map((line) =>
    line
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join('  ')
      .trimEnd(),
  )
  if (rows.length > shown.length) {
    lines.push(`... and ${rows.length - shown.length} more row(s)`)
  }
  return lines
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * The digest, or null when nothing is overdue.
 *
 * Null rather than a cheerful empty email: a daily message saying nothing is
 * late trains people to delete it unread, and the one that matters then goes
 * with it. A day on which documents are pending but none is late yet is such
 * a day - there would be nothing to attach.
 */
export function buildDigest(
  pending: readonly PendingDocumentRow[],
  options: DigestOptions = {},
): Digest | null {
  const rows = overdueRows(pending, options)
  if (rows.length === 0) return null

  const when = options.when ?? new Date()
  const employeeCount = new Set(rows.map((row) => row.employeeId)).size
  const people = count(employeeCount, 'employee')
  const documents = count(rows.length, 'overdue document')
  const fileName = overdueSheetFileName(when)

  const subject = `ASPS-DMS: ${people} with ${documents}`

  const text = [
    `${people} have ${documents}.`,
    '',
    `The list is attached as ${fileName}: one row per overdue document, with the`,
    'employee, the document, its due date and how many days it is late.',
    '',
    'This reminder repeats until the documents are uploaded.',
  ].join('\n')

  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a">` +
    `<p><strong>${escapeHtml(people)}</strong> have <strong>${escapeHtml(documents)}</strong>.</p>` +
    `<p>The list is attached as <code>${escapeHtml(fileName)}</code>: one row per overdue ` +
    `document, with the employee, the document, its due date and how many days it is late.</p>` +
    `<p style="color:#64748b;font-size:12px">This reminder repeats until the documents are uploaded.</p>` +
    `</div>`

  return {
    subject,
    text,
    html,
    employeeCount,
    overdueCount: rows.length,
    attachment: { fileName, bytes: buildOverdueSheet(rows, when), rowCount: rows.length },
    rows,
  }
}
