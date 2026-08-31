import type { RequestHandler } from 'express'
import { requestContext } from '../services/audit.service.js'
import * as reminderService from '../services/reminder.service.js'

/**
 * Sending the pending-documents digest now, rather than waiting for the
 * scheduled run.
 *
 * `?dryRun=true` renders it and sends nothing, so somebody can see exactly what
 * would go out - to real colleagues - before it does.
 */
export const send: RequestHandler = async (req, res) => {
  const context = requestContext(req)
  const result = await reminderService.sendPendingDocumentReminders({
    dryRun: req.query.dryRun === 'true',
    actor: req.user ? { userId: req.user.userId } : undefined,
    ipAddress: context.ipAddress,
  })

  res.json({
    reminder: {
      sent: result.sent,
      dryRun: result.dryRun,
      recipientCount: result.recipients.length,
      employeeCount: result.digest?.employeeCount ?? 0,
      documentCount: result.digest?.documentCount ?? 0,
      overdueCount: result.digest?.overdueCount ?? 0,
      subject: result.digest?.subject ?? null,
      // Only on a dry run: the rendered body is a convenience for whoever is
      // checking it, not something to echo back on every real send.
      preview: result.dryRun ? (result.digest?.text ?? null) : null,
    },
  })
}
