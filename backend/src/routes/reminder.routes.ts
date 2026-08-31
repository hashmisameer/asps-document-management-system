import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import { requirePermission } from '../middleware/requireAuth.js'
import * as reminderController from '../controllers/reminder.controller.js'

export const reminderRouter: Router = Router()

reminderRouter.post(
  '/send',
  requirePermission(PERMISSIONS.REMINDER_SEND),
  reminderController.send,
)
