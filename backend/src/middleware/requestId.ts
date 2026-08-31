import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'

/**
 * Assigns every request an id, echoed back as X-Request-Id.
 *
 * The same value becomes the `referenceId` on a 500 response, so a user can
 * quote the id from the screen and it can be found in the log. Runs first, so
 * every later middleware - including the logger - can rely on it.
 *
 * An inbound X-Request-Id is deliberately NOT trusted: it would let a caller
 * choose its own log correlation id, or inject header content.
 */
export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID()
  res.setHeader('X-Request-Id', req.requestId)
  next()
}
