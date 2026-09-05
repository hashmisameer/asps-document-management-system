import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import { requirePermission } from '../middleware/requireAuth.js'
import * as dashboardController from '../controllers/dashboard.controller.js'

export const dashboardRouter: Router = Router()

dashboardRouter.get(
  '/summary',
  requirePermission(PERMISSIONS.REPORT_READ),
  dashboardController.summary,
)
