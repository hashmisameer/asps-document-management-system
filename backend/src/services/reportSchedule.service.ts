import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { describeError } from '../utils/errors.js'
import { sendPendingDocumentReminders } from './reminder.service.js'

/**
 * The daily report email, sent by the API itself.
 *
 * It used to be a separate process for Windows Task Scheduler to run, and the
 * reasoning for that was sound: a timer inside the API cannot wedge it if the
 * mail server hangs, does not stop silently when the API restarts, and two API
 * instances would send two emails.
 *
 * The office asked for one place to configure it. A scheduled task is a second
 * place - one that lives on the machine, is invisible from the application, and
 * is forgotten the first time the server is rebuilt. So the schedule is
 * REPORT_SEND_TIME in .env and the API keeps it, with the three risks answered
 * rather than dodged:
 *
 *   HANGING     the send is awaited inside a task that catches everything. A
 *               mail server that never answers loses that day's email and
 *               nothing else; nothing in a request path waits on it.
 *   RESTARTS    the next send is scheduled from the clock, not from an interval,
 *               so a restart re-arms it rather than losing it.
 *   TWO COPIES  the day it last sent is remembered, and a send is skipped if
 *               that day has already gone out. Restarting at four in the
 *               afternoon does not produce a second email.
 *
 * TWO API INSTANCES WOULD STILL SEND TWO EMAILS. This is one server on the
 * office network - the assumption the whole deployment rests on - and if that
 * ever stops being true this is one of the things that has to move.
 *
 * `npm run send-reminders` still exists for sending one by hand, and for
 * `--dry-run` to see what would go out. It is an operator's tool, not a button
 * on a screen.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
/** The last date, YYYY-MM-DD, this process sent for. */
let lastSentOn: string | null = null

/** Today on the server's own clock, which is the clock REPORT_SEND_TIME is in. */
function localDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The next time the email is due, from now.
 *
 * Today's slot if it has not passed, otherwise tomorrow's. Worked out from the
 * wall clock every time rather than by adding 24 hours, so the hour stays put
 * across a daylight-saving change.
 */
export function nextSendAt(now: Date, sendTime: string): Date {
  const [hours = 9, minutes = 0] = sendTime.split(':').map(Number)

  const next = new Date(now)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)

  return next
}

/** Whether there is anywhere to send to. Configuration is the on switch. */
function isConfigured(): boolean {
  return env.REPORT_RECIPIENTS.length > 0 && Boolean(env.SMTP_HOST)
}

async function sendToday(): Promise<void> {
  const today = localDate(new Date())
  if (lastSentOn === today) {
    logger.info({ today }, "The daily report has already gone out today; not sending it again")
    return
  }

  try {
    const result = await sendPendingDocumentReminders()
    // Recorded whether or not there was anything to say: 'nothing is
    // outstanding' is a day's work done, and re-running it on the next restart
    // would email the office twice about it.
    lastSentOn = today
    logger.info(
      { sent: result.sent, recipients: result.recipients.length },
      result.sent ? 'The daily report has been sent' : 'Nothing was outstanding; no report sent',
    )
  } catch (error) {
    // A mail server that will not answer loses today's email. It does not stop
    // tomorrow's, and it does not touch anything else the API is doing.
    logger.error({ err: error }, `The daily report could not be sent: ${describeError(error)}`)
  }
}

/** Arms the timer for the next slot, and re-arms it after each send. */
function arm(): void {
  const at = nextSendAt(new Date(), env.REPORT_SEND_TIME)
  const wait = Math.max(1000, at.getTime() - Date.now())

  timer = setTimeout(() => {
    void sendToday().finally(arm)
  }, Math.min(wait, ONE_DAY_MS))

  // Node must be free to exit on its own; this timer is not a reason to stay up.
  timer.unref()

  logger.info({ at: at.toISOString() }, 'The next daily report is scheduled')
}

/**
 * Starts the daily send, if there is anywhere to send to.
 *
 * Called once at boot. Says plainly in the log which of the two it did, so
 * 'why has the office had no email' is answered by the first lines of the log
 * rather than by reading configuration.
 */
export function startDailyReport(): void {
  if (timer) return

  if (!isConfigured()) {
    logger.info(
      'No daily report will be sent: set REPORT_RECIPIENTS and SMTP_HOST to turn it on.',
    )
    return
  }

  arm()
}

/** Stops it, for shutdown and for tests. */
export function stopDailyReport(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
}

/** Test seam: forgets that today's email has gone. */
export function resetDailyReportState(): void {
  stopDailyReport()
  lastSentOn = null
}
