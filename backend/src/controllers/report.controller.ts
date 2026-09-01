import type { RequestHandler } from 'express'
import { z } from 'zod'
import { booleanQueryParam } from '@asps-dms/shared'
import * as reportRepository from '../repositories/report.repository.js'
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
