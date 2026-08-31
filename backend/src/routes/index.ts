import { Router } from 'express'
import { authRouter } from './auth.routes.js'
import { healthRouter } from './health.routes.js'

/**
 * The API router, mounted at /api.
 *
 * Feature routers are added here as each milestone lands: users (M2),
 * employees and documents (M3), signatures (M4), reports (M5).
 *
 * Health and auth are mounted before any authentication gate, for the obvious
 * reason that an uptime check and a login form cannot require a session.
 */
export const apiRouter: Router = Router()

apiRouter.use(healthRouter)
apiRouter.use(authRouter)
