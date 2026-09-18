/**
 * Sends the overdue-documents reminder, once.
 *
 *   npm run send-reminders              - build and send
 *   npm run send-reminders -- --dry-run - build and print it, send nothing
 *
 * The dry run prints the email as it would go and the first rows of the sheet
 * that would be attached, with how many rows it has in all. Nothing is
 * written anywhere - no file, no email, no audit entry.
 *
 * Meant to be run by Windows Task Scheduler on the company server, daily. A
 * separate process rather than a timer inside the API, for three reasons: it
 * cannot wedge the API if the mail server hangs, it does not silently stop when
 * the API restarts, and two API instances would otherwise send two emails.
 *
 * Exits non-zero on failure so the scheduler reports it rather than recording a
 * successful run that sent nothing.
 */
import { closePool } from '../database/pool.js'
import { logger } from '../utils/logger.js'
import { sendPendingDocumentReminders } from '../services/reminder.service.js'
import { previewSheet } from '../services/reminderDigest.service.js'
import { describeError } from '../utils/errors.js'

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  const result = await sendPendingDocumentReminders({ dryRun })

  if (!result.digest) {
    console.log('Nothing is overdue. No reminder sent.')
    return
  }

  const { digest } = result
  console.log(`Subject: ${digest.subject}`)
  console.log(
    `${digest.employeeCount} employee(s), ${digest.overdueCount} overdue document(s); ` +
      `attachment ${digest.attachment.fileName} (${digest.attachment.rowCount} row(s))`,
  )

  if (result.dryRun) {
    console.log(`\nWould send to: ${result.recipients.join(', ') || '(nobody configured)'}\n`)
    console.log(digest.text)
    console.log(`\n${digest.attachment.fileName} - ${digest.attachment.rowCount} row(s):\n`)
    for (const line of previewSheet(digest.rows)) console.log(line)
    console.log('\nDry run: nothing was sent and nothing was written.')
    return
  }

  console.log(`Sent to ${result.recipients.length} recipient(s).`)
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Reminder run failed')
    console.error(`\nReminders were not sent: ${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
