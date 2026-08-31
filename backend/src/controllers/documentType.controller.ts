import type { RequestHandler } from 'express'
import { documentTypeListQuerySchema } from '@asps-dms/shared'
import * as documentTypeService from '../services/documentType.service.js'
import { parseQuery } from '../utils/validation.js'

export const list: RequestHandler = async (req, res) => {
  const query = parseQuery(req, documentTypeListQuerySchema)
  res.json({ documentTypes: await documentTypeService.list(query) })
}
