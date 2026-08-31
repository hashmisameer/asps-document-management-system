import { Router } from 'express'
import * as authController from '../controllers/auth.controller.js'
import * as registrationController from '../controllers/registration.controller.js'
import { loginLimiter } from '../middleware/rateLimit.js'
import { requireAuth } from '../middleware/requireAuth.js'

/**
 * /api/auth
 *
 * These four routes are deliberately outside the requirePasswordChanged gate:
 * an account that must set a new password still has to be able to see who it
 * is, set that password, and sign out.
 */
export const authRouter: Router = Router()

authRouter.post('/auth/login', loginLimiter, authController.login)

// Public, and rate limited with the same bucket as signing in: both are ways of
// hammering the accounts table from outside, and neither should be cheap.
authRouter.get('/auth/registration', registrationController.status)
authRouter.post('/auth/register', loginLimiter, registrationController.register)
authRouter.post('/auth/logout', requireAuth, authController.logout)
authRouter.get('/auth/me', requireAuth, authController.me)
authRouter.post(
  '/auth/change-password',
  requireAuth,
  loginLimiter,
  authController.changePassword,
)
