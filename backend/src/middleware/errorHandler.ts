import type { ErrorRequestHandler, RequestHandler } from 'express'
import { z } from 'zod'
import { API_ERROR_CODES, type ApiErrorBody } from '@asps-dms/shared'
import { logger } from '../utils/logger.js'
import {
  AppError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  describeError,
  isAppError,
} from '../utils/errors.js'
import { toValidationIssues } from '../utils/validation.js'

/**
 * The single place an error becomes an HTTP response.
 *
 * Express 5 forwards a rejected promise from an async handler here on its own,
 * so route handlers need no try/catch wrapper and no asyncHandler helper.
 *
 * Two rules hold for every response produced here:
 *   1. A 5xx never reveals what actually failed. The real error goes to the
 *      log with the request id; the caller gets a generic message and that id
 *      as `referenceId`, which is enough to find it.
 *   2. Nothing from a driver, a file path or a stack trace is ever serialised.
 */

/** Shape of the errors body-parser throws: `status` plus a `type` tag. */
interface BodyParserError extends Error {
  status?: number
  statusCode?: number
  type?: string
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && typeof (err as BodyParserError).type === 'string'
}

/** Maps anything thrown into the one hierarchy the responder understands. */
function normalise(err: unknown): AppError {
  if (isAppError(err)) return err

  if (err instanceof z.ZodError) {
    // A schema that was parsed outside the controller helpers.
    return new ValidationError(toValidationIssues(err))
  }

  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      return new PayloadTooLargeError()
    }
    if (err.type === 'entity.parse.failed') {
      return new AppError(400, API_ERROR_CODES.INVALID_JSON, undefined, { cause: err })
    }
    if (err.type === 'entity.verify.failed' || err.type === 'encoding.unsupported') {
      return new AppError(400, API_ERROR_CODES.BAD_REQUEST, undefined, { cause: err })
    }
  }

  return new InternalError(undefined, { cause: err })
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.path}.`))
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Once the response has started there is no envelope left to send; Express's
  // default handler is the only thing that can close the connection cleanly.
  if (res.headersSent) {
    next(err)
    return
  }

  const appError = normalise(err)
  const referenceId = req.requestId

  const logContext = {
    requestId: referenceId,
    method: req.method,
    path: req.path,
    statusCode: appError.statusCode,
    code: appError.code,
    userId: req.user?.userId ?? null,
  }

  if (appError.isServerError) {
    // `err` rather than `appError`: the cause chain is what makes a 500
    // diagnosable, and it is logged exactly here and nowhere else.
    logger.error({ ...logContext, err }, `Request failed: ${describeError(err)}`)
  } else {
    logger.warn(logContext, `Request rejected: ${appError.code}`)
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.isServerError
        ? 'Something went wrong. Please try again, and quote the reference below if it keeps happening.'
        : appError.message,
    },
  }

  // Details describe what the caller got wrong, so they belong on a 4xx only.
  if (!appError.isServerError && appError.details !== undefined) {
    body.error.details = appError.details
  }
  if (appError.isServerError) {
    body.error.referenceId = referenceId
  }

  res.status(appError.statusCode).json(body)
}
