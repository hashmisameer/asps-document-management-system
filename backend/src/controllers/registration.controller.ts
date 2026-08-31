import type { RequestHandler } from 'express'
import { registerSchema } from '@asps-dms/shared'
import * as registrationService from '../services/registration.service.js'
import { requestContext } from '../services/audit.service.js'
import { parseBody } from '../utils/validation.js'

/**
 * Registration: the only route that creates an account without one.
 *
 * The status route is public because the sign-in page has to know whether to
 * offer the link at all, and it says nothing an attacker gains from - how many
 * slots are left, not who holds them.
 */

export const status: RequestHandler = async (_req, res) => {
  res.json({ registration: await registrationService.getStatus() })
}

export const register: RequestHandler = async (req, res) => {
  const input = parseBody(req, registerSchema)
  const created = await registrationService.register(input, requestContext(req))

  // No session is issued. Registering and signing in are separate acts, so a
  // stolen registration does not also hand over a live session, and the new
  // account proves it knows the password it just set.
  res.status(201).json({
    registered: { username: created.username, role: created.role },
  })
}
