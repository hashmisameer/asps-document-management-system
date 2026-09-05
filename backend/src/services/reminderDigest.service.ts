import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  deriveDeadline,
  type DeadlineState,
} from '@asps-dms/shared'
import type { PendingDocumentRow } from '../repositories/reminder.repository.js'

/**
 * Building the pending-documents digest.
 *
 * One email, to several addresses, listing each employee who still owes a
 * document and naming the documents. It goes out again on every run until the
 * file is uploaded - that is the point of it, and it is why the digest is
 * rebuilt from the current state each time rather than remembering what it said
 * yesterday. Nothing is stored about a reminder having been sent, so there is
 * no state to drift out of step with the checklist.
 *
 * This module is pure: rows in, subject and body out. Reading the database and
 * talking to a mail server happen elsewhere, so the wording and the grouping -
 * the parts that are wrong in ways a person notices - can be tested against
 * plain data with no SMTP server and no clock.
 */

export interface DigestEmployee {
  employeeId: number
  employeeCode: string
  employeeName: string
  documents: DigestDocument[]
}

export interface DigestDocument {
  documentName: string
  isMandatory: boolean
  dueDate: string | null
  state: DeadlineState
  /** 'Overdue by 3 days', 'Due today', 'Due in 2 days', 'No deadline'. */
  label: string
}

export interface Digest {
  subject: string
  text: string
  html: string
  employeeCount: number
  documentCount: number
  overdueCount: number
}

/** Sorted worst-first, so the row that has been waiting longest is read first. */
const STATE_ORDER: Readonly<Record<string, number>> = {
  [DEADLINE_STATE.OVERDUE]: 0,
  [DEADLINE_STATE.DUE_TODAY]: 1,
  [DEADLINE_STATE.DUE_SOON]: 2,
  [DEADLINE_STATE.NOT_DUE]: 3,
  [DEADLINE_STATE.NOT_APPLICABLE]: 4,
  [DEADLINE_STATE.COMPLETED]: 5,
}

export interface DigestOptions {
  /** Include documents whose date has not arrived yet. Off by default. */
  includeNotYetDue?: boolean
  /** Date-only, for testing. Defaults to today. */
  today?: string
}

/**
 * Groups pending rows into one entry per employee, worst deadline first.
 *
 * A document with no deadline at all is still included: it is genuinely
 * outstanding, and dropping it would mean an employee could owe a document that
 * no reminder ever mentions.
 */
export function groupPending(
  rows: readonly PendingDocumentRow[],
  options: DigestOptions = {},
): DigestEmployee[] {
  const includeNotYetDue = options.includeNotYetDue ?? false
  const byEmployee = new Map<number, DigestEmployee>()

  for (const row of rows) {
    // Status is Pending by definition here - these rows have no file - so the
    // deadline is derived against that rather than against a stored status
    // this query does not read.
    const deadline = deriveDeadline(row.dueDate, DOCUMENT_STATUS.PENDING, {
      ...(options.today ? { today: options.today } : {}),
    })

    if (!includeNotYetDue && deadline.state === DEADLINE_STATE.NOT_DUE) continue

    let entry = byEmployee.get(row.employeeId)
    if (!entry) {
      entry = {
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        documents: [],
      }
      byEmployee.set(row.employeeId, entry)
    }

    entry.documents.push({
      documentName: row.documentName,
      isMandatory: row.isMandatory,
      dueDate: row.dueDate,
      state: deadline.state,
      label: deadline.label,
    })
  }

  const employees = [...byEmployee.values()]
  for (const employee of employees) {
    employee.documents.sort(
      (a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9),
    )
  }

  // Employees with something overdue come first, then by how much is
  // outstanding: the digest is a worklist, so it is ordered like one.
  return employees.sort((a, b) => {
    const aWorst = STATE_ORDER[a.documents[0]?.state ?? ''] ?? 9
    const bWorst = STATE_ORDER[b.documents[0]?.state ?? ''] ?? 9
    if (aWorst !== bWorst) return aWorst - bWorst
    if (a.documents.length !== b.documents.length) return b.documents.length - a.documents.length
    return a.employeeCode.localeCompare(b.employeeCode)
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The digest, or null when there is nothing outstanding.
 *
 * Null rather than a cheerful empty email: a daily message saying nothing is
 * wrong trains people to delete it unread, and the one that matters then goes
 * with it.
 */
export function buildDigest(
  rows: readonly PendingDocumentRow[],
  options: DigestOptions = {},
): Digest | null {
  const employees = groupPending(rows, options)
  if (employees.length === 0) return null

  const documentCount = employees.reduce((sum, e) => sum + e.documents.length, 0)
  const overdueCount = employees.reduce(
    (sum, e) => sum + e.documents.filter((d) => d.state === DEADLINE_STATE.OVERDUE).length,
    0,
  )

  const people = employees.length === 1 ? '1 employee' : `${employees.length} employees`
  const subject =
    overdueCount > 0
      ? `ASPS-DMS: ${people} with pending documents (${overdueCount} overdue)`
      : `ASPS-DMS: ${people} with pending documents`

  const textLines: string[] = [
    `${people} have documents that have not been uploaded.`,
    '',
  ]
  const htmlRows: string[] = []

  for (const employee of employees) {
    textLines.push(`${employee.employeeCode}  ${employee.employeeName}`)
    for (const document of employee.documents) {
      const mandatory = document.isMandatory ? ' [mandatory]' : ''
      textLines.push(`    ${document.documentName.padEnd(24)}${document.label}${mandatory}`)
    }
    textLines.push('')

    const documentCells = employee.documents
      .map((document) => {
        const overdue = document.state === DEADLINE_STATE.OVERDUE
        const mandatory = document.isMandatory
          ? ' <strong style="color:#b45309">[mandatory]</strong>'
          : ''
        return (
          `<li>${escapeHtml(document.documentName)} &mdash; ` +
          `<span style="color:${overdue ? '#b91c1c' : '#475569'}">${escapeHtml(document.label)}</span>` +
          `${mandatory}</li>`
        )
      })
      .join('')

    htmlRows.push(
      `<tr>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:nowrap">` +
        `<strong>${escapeHtml(employee.employeeCode)}</strong><br>${escapeHtml(employee.employeeName)}` +
        `</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">` +
        `<ul style="margin:0;padding-left:18px">${documentCells}</ul>` +
        `</td>` +
        `</tr>`,
    )
  }

  textLines.push('This reminder repeats until the documents are uploaded.')

  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a">` +
    `<p>${escapeHtml(people)} have documents that have not been uploaded.</p>` +
    `<table style="border-collapse:collapse;min-width:480px">` +
    `<thead><tr>` +
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #cbd5e1">Employee</th>` +
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #cbd5e1">Pending documents</th>` +
    `</tr></thead><tbody>${htmlRows.join('')}</tbody></table>` +
    `<p style="color:#64748b;font-size:12px">This reminder repeats until the documents are uploaded.</p>` +
    `</div>`

  return {
    subject,
    text: textLines.join('\n'),
    html,
    employeeCount: employees.length,
    documentCount,
    overdueCount,
  }
}
