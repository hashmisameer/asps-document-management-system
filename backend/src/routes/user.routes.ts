import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as userController from '../controllers/user.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'

/**
 * User accounts: the Users screen. Every route needs user:manage, which only
 * an administrator holds. There is no DELETE - a user is deactivated, never
 * removed, because documents were signed in their name.
 */
export const userRouter: Router = Router()

userRouter.get('/', requirePermission(PERMISSIONS.USER_MANAGE), userController.list)
userRouter.post('/', requirePermission(PERMISSIONS.USER_MANAGE), userController.create)
userRouter.patch('/:userId', requirePermission(PERMISSIONS.USER_MANAGE), userController.update)
userRouter.post(
  '/:userId/reset-password',
  requirePermission(PERMISSIONS.USER_MANAGE),
  userController.resetPassword,
)
