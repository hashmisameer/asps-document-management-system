import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_ACTIONS, XLSX_MIME_TYPE } from '@asps-dms/shared'
import type { PendingDocumentRow } from '../../src/repositories/reminder.repository.js'
import { readXlsx } from '../../src/utils/xlsx.js'

/**
 * Sending the digest: what goes to the mail server, and when nothing does.
 *
 * The wording and the sheet are pinned in reminderDigest.test.ts against plain
 * rows. What is checked here is the last step - that the sheet is actually on
 * the email, under the right name and type, that a dry run reaches the mail
 * server never, and that a day with nothing overdue sends nothing and records
 * nothing.
 */

// Somewhere to send to, and something to send with. Read by config/env.ts
// when it is first imported, which is why the service is imported below
// rather than at the top.
process.env.SMTP_HOST = 'mail.test.invalid'
process.env.REPORT_RECIPIENTS = 'hr@example.com, accounts@example.com'

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(),
  findPendingDocuments: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mail.sendMail }) },
}))
vi.mock('../../src/repositories/reminder.repository.js', () => ({
  findPendingDocuments: mail.findPendingDocuments,
}))
vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: mail.insertAudit }))

const { sendPendingDocumentReminders } = await import('../../src/services/reminder.service.js')

/** A document that fell due a week ago. */
function overdue(overrides: Partial<PendingDocumentRow> = {}): PendingDocumentRow {
  const due = new Date()
  due.setDate(due.getDate() - 7)
  return {
    employeeId: 1,
    employeeCode: '00005696',
    employeeName: 'Ravi Kumar',
    department: 'Stitching',
    documentName: 'Aadhaar Card',
    isMandatory: true,
    dueDate: due.toISOString().slice(0, 10),
    ...overrides,
  }
}

/** A document not due for a month: pending, not late. */
function pending(): PendingDocumentRow {
  const due = new Date()
  due.setDate(due.getDate() + 30)
  return overdue({ documentName: 'Confirmation Letter', dueDate: due.toISOString().slice(0, 10) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mail.sendMail.mockResolvedValue({ messageId: 'x' })
  mail.insertAudit.mockResolvedValue(undefined)
})

describe('sending', () => {
  it('attaches the sheet, named for today, as an .xlsx', async () => {
    mail.findPendingDocuments.mockResolvedValue([
      overdue({ documentName: 'Aadhaar Card' }),
      overdue({ documentName: 'PAN Card' }),
    ])

    const result = await sendPendingDocumentReminders()

    expect(result.sent).toBe(true)
    expect(result.recipients).toEqual(['hr@example.com', 'accounts@example.com'])
    expect(mail.sendMail).toHaveBeenCalledTimes(1)

    const message = mail.sendMail.mock.calls[0]?.[0] as {
      to: string
      subject: string
      attachments: { filename: string; content: Buffer; contentType: string }[]
    }
    expect(message.to).toBe('hr@example.com, accounts@example.com')
    expect(message.subject).toBe('ASPS-DMS: 1 employee with 2 overdue documents')
    expect(message.attachments).toHaveLength(1)

    const [attachment] = message.attachments
    expect(attachment?.filename).toMatch(/^asps-dms-overdue-documents-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(attachment?.contentType).toBe(XLSX_MIME_TYPE)
    expect(Buffer.isBuffer(attachment?.content)).toBe(true)
    // The bytes on the wire are the sheet: heading row plus one per document.
    expect(readXlsx(attachment?.content ?? Buffer.alloc(0))).toHaveLength(3)
  })

  it('records that it left the building, with the counts and the file name', async () => {
    mail.findPendingDocuments.mockResolvedValue([overdue()])

    await sendPendingDocumentReminders({ actor: { userId: 7 }, ipAddress: '10.0.0.5' })

    expect(mail.insertAudit).toHaveBeenCalledTimes(1)
    const entry = mail.insertAudit.mock.calls[0]?.[0] as { action: string; metadataJson: string }
    expect(entry.action).toBe(AUDIT_ACTIONS.REMINDER_SENT)
    expect(JSON.parse(entry.metadataJson)).toMatchObject({
      recipientCount: 2,
      employees: 1,
      overdue: 1,
      trigger: 'Manual',
    })
    expect(JSON.parse(entry.metadataJson).attachment).toMatch(/\.xlsx$/)
  })
})

describe('not sending', () => {
  it('sends nothing on a dry run, and still says what the sheet would hold', async () => {
    mail.findPendingDocuments.mockResolvedValue([overdue(), overdue({ documentName: 'PAN Card' })])

    const result = await sendPendingDocumentReminders({ dryRun: true })

    expect(result.sent).toBe(false)
    expect(result.dryRun).toBe(true)
    expect(result.digest?.attachment.rowCount).toBe(2)
    expect(result.digest?.rows).toHaveLength(2)
    expect(mail.sendMail).not.toHaveBeenCalled()
    expect(mail.insertAudit).not.toHaveBeenCalled()
  })

  it('sends nothing when documents are pending but none is overdue', async () => {
    mail.findPendingDocuments.mockResolvedValue([pending(), pending()])

    const result = await sendPendingDocumentReminders()

    expect(result.sent).toBe(false)
    expect(result.digest).toBeNull()
    expect(mail.sendMail).not.toHaveBeenCalled()
    expect(mail.insertAudit).not.toHaveBeenCalled()
  })
})
