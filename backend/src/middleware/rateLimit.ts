import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'
import { TooManyRequestsError } from '../utils/errors.js'

/**
 * A blunt per-IP ceiling across the whole API.
 *
 * This is an internal LAN application, so the limit is set high enough that
 * ordinary use - a busy HR user with several tabs open - never reaches it. Its
 * job is to stop a runaway client or a scripted brute-force, not to shape
 * traffic. Tighter, per-route limits (login especially) arrive with
 * authentication in Milestone 2.
 *
 * Disabled under NODE_ENV=test so a test run cannot exhaust the budget and
 * turn later assertions into confusing 429s.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  handler: (_req, _res, next) => {
    next(new TooManyRequestsError())
  },
})
