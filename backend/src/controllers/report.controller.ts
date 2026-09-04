import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import {
  booleanQueryParam,
  documentEmployeesQuerySchema,
  idParamSchema,
  printDocumentEmployeesQuerySchema,
  type AuthUser,
} from '@asps-dms/shared'
import * as reportRepository from '../repositories/report.repository.js'
import { printDocumentList } from '../services/documentListReport.service.js'
import { UnauthenticatedError } from '../utils/errors.js'
import { parseQuery } from '../utils/validation.js'

/**
 * The reports. Read-only, and gated on REPORT_READ so management can see them
 * without being able to change anything.
 */

const outstandingQuerySchema = z.object({
  department: z.string().trim().max(100).optional(),
  onlyOverdue: booleanQueryParam.default(false),
  onlyMandatory: booleanQueryParam.default(false),
})

export const byDocumentType: RequestHandler = async (_req, res) => {
  res.json({ rows: await reportRepository.byDocumentType() })
}

export const outstanding: RequestHandler = async (req, res) => {
  const query = parseQuery(req, outstandingQuerySchema)
  res.json(await reportRepository.outstanding(query))
}

/**
 * Who has left.
 *
 * The exits and the per-department totals in one response: they are read
 * together, and two round trips for one screen is two chances for the numbers to
 * disagree with each other.
 */
export const exits: RequestHandler = async (_req, res) => {
  const [rows, byDepartment] = await Promise.all([
    reportRepository.exits(),
    reportRepository.exitsByDepartment(),
  ])
  res.json({ exits: rows, byDepartment })
}

/**
 * The employees behind one row of the by-document report.
 *
 * Read-only, and gated on REPORT_READ like the rest of this file - a Viewer may
 * see who is outstanding, which is the point of a report, without being able to
 * do anything about it.
 */
export const employeesForDocumentType: RequestHandler = async (req, res) => {
  const documentTypeId = idParamSchema.parse(req.params.documentTypeId)
  const query = parseQuery(req, documentEmployeesQuerySchema)

  const result = await reportRepository.employeesForDocumentType({ ...query, documentTypeId })
  res.json({
    rows: result.rows,
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

/**
 * requireAuth runs before every route here, so a missing user means the router
 * was wired wrong. Failing closed is the only safe way to report that.
 */
function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

/**
 * The same list, as a PDF to carry round.
 *
 * REPORT_READ like everything else in this file, so a Viewer can print one -
 * reading a report and printing the report are the same act.
 *
 * The query is the screen's query WITHOUT its paging: the filters and the sort
 * come through, and every matching employee is printed rather than the
 * twenty-five that happened to be on screen.
 */
export const printEmployeesForDocumentType: RequestHandler = async (req, res) => {
  const documentTypeId = idParamSchema.parse(req.params.documentTypeId)
  const filters = parseQuery(req, printDocumentEmployeesQuerySchema)

  const { fileName, pdf } = await printDocumentList(documentTypeId, filters, actorOf(req))

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('Content-Length', String(pdf.length))
  // A list of names and departments must not sit in a shared cache.
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(pdf)
}