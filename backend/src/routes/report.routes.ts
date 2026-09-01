import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import { requirePermission } from '../middleware/requireAuth.js'
import * as reportController from '../controllers/report.controller.js'

export const reportRouter: Router = Router()

reportRouter.get(
  '/by-document-type',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.byDocumentType,
)

reportRouter.get(
  '/outstanding',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.outstanding,
)
