import type { Request, RequestHandler } from 'express'
import { idParamSchema, saveTemplateSchema, type AuthUser } from '@asps-dms/shared'
import { requestContext } from '../services/audit.service.js'
import * as placementTemplateService from '../services/placementTemplate.service.js'
import * as templateShapes from '../services/templateShapes.service.js'
import { UnauthenticatedError } from '../utils/errors.js'
import { parseBody } from '../utils/validation.js'

/**
 * Placement templates, under /api/document-types.
 *
 * Every route needs TEMPLATE_MANAGE, which only an administrator holds: a
 * template is set once and is wrong for every employee if it is wrong once.
 */

function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

/** Every active type with its template at a glance. */
export const list: RequestHandler = async (_req, res) => {
  res.json({ templates: await placementTemplateService.list() })
}

/** The shapes of the type's stored documents, for the editor's sample and warning. */
export const shapesForType: RequestHandler = async (req, res) => {
  const documentTypeId = idParamSchema.parse(req.params.documentTypeId)
  res.json({ shapes: await templateShapes.shapesForType(documentTypeId) })
}

export const getForType: RequestHandler = async (req, res) => {
  const documentTypeId = idParamSchema.parse(req.params.documentTypeId)
  res.json({ placements: await placementTemplateService.getForType(documentTypeId) })
}

export const save: RequestHandler = async (req, res) => {
  const documentTypeId = idParamSchema.parse(req.params.documentTypeId)
  const input = parseBody(req, saveTemplateSchema)
  const saved = await placementTemplateService.save(
    documentTypeId,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json(saved)
}
