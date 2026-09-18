import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import type { AuthUser } from '@asps-dms/shared'
import { requestContext } from '../services/audit.service.js'
import * as importRun from '../services/employeeImportRun.service.js'
import { BadRequestError, UnauthenticatedError } from '../utils/errors.js'
import { parseBody } from '../utils/validation.js'

/**
 * Importing employees from a spreadsheet, from the screen.
 *
 * Two routes and one file each: a preview that writes nothing, and a commit
 * that creates the rows the preview said it would. The file is sent to both,
 * because nothing is kept on the server in between.
 */

/**
 * How slashed dates are read. Defaults to day/month/year, which is how the
 * Add Employee form asks for a date and how the office writes one; the other
 * reading is for an old export. Excel's own date cells carry a serial and
 * ignore this.
 */
const importOptionsSchema = z.object({
  dateFormat: z.enum(['dmy', 'mdy']).default('dmy'),
})

function fileOf(req: Request): { originalname: string; buffer: Buffer } {
  if (!req.file) throw new BadRequestError("Attach the spreadsheet in a form field named 'file'.")
  return { originalname: req.file.originalname, buffer: req.file.buffer }
}

function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

// The file is checked before the options: a request with no file has no body
// worth validating, and 'attach the spreadsheet' is the message that helps.
export const preview: RequestHandler = async (req, res) => {
  const file = fileOf(req)
  const { dateFormat } = parseBody(req, importOptionsSchema)
  res.json({ preview: await importRun.preview(file, dateFormat, actorOf(req)) })
}

export const commit: RequestHandler = async (req, res) => {
  const file = fileOf(req)
  const { dateFormat } = parseBody(req, importOptionsSchema)
  const result = await importRun.commit(file, dateFormat, actorOf(req), requestContext(req))
  res.status(201).json({ result })
}
