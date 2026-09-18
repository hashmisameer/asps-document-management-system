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

/* The shapes of the type's stored documents - how many are A4 portrait, how
   many something else - measured from the files. What the editor shows beside
   a sample, and what warns when a sample is a shape few documents have. */
documentTypeRouter.get(
  '/:documentTypeId/shapes',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  placementTemplateController.shapesForType,
)

documentTypeRouter.put(
  '/:documentTypeId/placements',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  placementTemplateController.save,
)
