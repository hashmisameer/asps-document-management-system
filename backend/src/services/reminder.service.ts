import nodemailer, { type Transporter } from 'nodemailer'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@asps-dms/shared'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { ConflictError } from '../utils/errors.js'
import * as reminderRepository from '../repositories/reminder.repository.js'
import { buildDigest, type Digest } from './reminderDigest.service.js'
import * as audit from './audit.service.js'

/**
 * Sending the pending-documents digest.
 *
 * One email to every address in REPORT_RECIPIENTS, listing the employees who
 * still owe documents and naming those documents. It repeats on every run until
 * the file is uploaded, because the digest is built from the current state each
 * time - nothing records that a reminder was sent, so nothing can fall out of
 * step with the checklist.
 *
 * Two ways in, deliberately. A scheduled run on the server does the daily work,
 * and an authenticated endpoint sends one now, which is what somebody actually
 * wants when they have just added a batch of employees.
 */

export interface ReminderResult {
  sent: boolean
  /** Absent when nothing was outstanding. */
  digest: Digest | null
  recipients: string[]
  /** True when the digest was built and rendered but not actually sent. */
  dryRun: boolean
}

let transporter: Transporter | null = null

/**
 * The SMTP transport, made once.
 *
 * Authentication is only configured when a user is set: an internal relay on
 * the company LAN commonly accepts mail from the server without credentials,
 * and sending an empty auth block to one of those fails the connection.
 */
function getTransport(): Transporter {
  if (transporter) return transporter
  if (!env.SMTP_HOST) {
    throw new ConflictError('No mail server is configured, so reminders cannot be sent.')
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  })

  return transporter
}

/**
 * Builds the digest and sends it.
 *
 * `dryRun` renders it and returns it without sending, which is how this is
 * exercised before the company's mail server details are known - and how anyone
 * can see what would go out before it goes out.
 *
 * Nothing is sent when nothing is outstanding. A daily email saying all is well
 * teaches people to delete it unread, taking the one that mattered with it.
 */
export async function sendPendingDocumentReminders(
  options: {
    dryRun?: boolean
    actor?: { userId: number } | undefined
    ipAddress?: string | null
  } = {},
): Promise<ReminderResult> {
  const dryRun = options.dryRun ?? false
  const recipients = env.REPORT_RECIPIENTS

  const rows = await reminderRepository.findPendingDocuments()
  const digest = buildDigest(rows, { includeNotYetDue: env.REPORT_INCLUDE_NOT_YET_DUE })

  if (!digest) {
    logger.info({ pendingRows: rows.length }, 'No pending documents; no reminder sent')
    return { sent: false, digest: null, recipients, dryRun }
  }

  if (dryRun) {
    return { sent: false, digest, recipients, dryRun: true }
  }

  // A dry run works whatever is configured - seeing what would go out is how
  // the wording gets checked before anybody is on the receiving end of it.
  // Sending needs somewhere to send to, which a freshly deployed server does
  // not have, so it cannot start emailing the office by itself.
  if (recipients.length === 0) {
    throw new ConflictError(
      'No addresses are configured in REPORT_RECIPIENTS, so there is nobody to email.',
    )
  }

  await getTransport().sendMail({
    from: env.SMTP_FROM ?? env.SMTP_USER ?? 'asps-dms@localhost',
    // One message addressed to everyone, which is what was asked for: the list
    // is a group of colleagues who all chase the same paperwork, not separate
    // recipients who should be hidden from each other.
    to: recipients.join(', '),
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
  })

  logger.info(
    {
      recipientCount: recipients.length,
      employees: digest.employeeCount,
      documents: digest.documentCount,
      overdue: digest.overdueCount,
    },
    'Pending-document reminder sent',
  )

  // Recorded because it left the building. Addresses are counted rather than
  // listed: the audit trail is read by more people than the mailing list is.
  await audit.record({
    userId: options.actor?.userId ?? null,
    action: AUDIT_ACTIONS.REMINDER_SENT,
    entityType: AUDIT_ENTITY_TYPES.REMINDER,
    entityId: null,
    ipAddress: options.ipAddress ?? null,
    metadata: {
      recipientCount: recipients.length,
      employees: digest.employeeCount,
      documents: digest.documentCount,
      overdue: digest.overdueCount,
      trigger: options.actor ? 'Manual' : 'Scheduled',
    },
  })

  return { sent: true, digest, recipients, dryRun: false }
}
