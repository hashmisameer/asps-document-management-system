import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as documentTypeController from '../controllers/documentType.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'

/** /api/document-types - the configurable checklist, read-only for now. */
export const documentTypeRouter: Router = Router()

documentTypeRouter.get(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_TYPE_READ),
  documentTypeController.list,
)
