import type { Request } from 'express'
import { z } from 'zod'
import type { ApiValidationIssue } from '@asps-dms/shared'
import { ValidationError } from './errors.js'

/**
 * Request validation.
 *
 * Done inside controllers with these helpers rather than by a middleware that
 * mutates the request: `req.query` is a getter in Express 5, so a middleware
 * cannot replace it with the parsed value, and the parsed result stays fully
 * typed here instead of arriving as `unknown` on a merged request property.
 *
 * Schemas come from `@asps-dms/shared`, so the browser and the server reject
 * exactly the same input.
 */

export function toValidationIssues(error: z.ZodError): ApiValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

/** Parses `value`, throwing a 400 ValidationError carrying the field issues. */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what = 'request',
): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ValidationError(
      toValidationIssues(result.error),
      `Some of the information in the ${what} is not valid.`,
    )
  }
  return result.data as z.infer<S>
}

export function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return parse(schema, req.body, 'request body')
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return parse(schema, req.query, 'query string')
}

export function parseParams<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return parse(schema, req.params, 'URL')
}
