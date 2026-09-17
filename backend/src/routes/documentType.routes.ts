import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as documentTypeController from '../controllers/documentType.controller.js'
import * as placementTemplateController from '../controllers/placementTemplate.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'

/** /api/document-types - the configurable checklist, read-only for now. */
export const documentTypeRouter: Router = Router()

documentTypeRouter.get(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_TYPE_READ),
  documentTypeController.list,
)

/**
 * Placement templates: where the signatures and the photograph go on every
 * document of a type. TEMPLATE_MANAGE on all three - an administrator's, not
 * HR's - and none of them touches a document or a stored file.
 *
 * '/placements' is declared before '/:documentTypeId/placements' so the word
 * is a route and not an id that fails to parse.
 */
documentTypeRouter.get(
  '/placements',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  placementTemplateController.list,
)

documentTypeRouter.get(
  '/:documentTypeId/placements',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  placementTemplateController.getForType,
)

documentTypeRouter.put(
  '/:documentTypeId/placements',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  placementTemplateController.save,
)
