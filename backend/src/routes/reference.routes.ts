import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import { requirePermission } from '../middleware/requireAuth.js'
import * as referenceController from '../controllers/reference.controller.js'

export const referenceRouter: Router = Router()

referenceRouter.get(
  '/',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  referenceController.list,
)
