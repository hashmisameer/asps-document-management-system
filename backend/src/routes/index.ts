import { Router } from 'express'
import { healthRouter } from './health.routes.js'

/**
 * The API router, mounted at /api.
 *
 * Feature routers are added here as each milestone lands: auth and users
 * (M2), employees and documents (M3), signatures (M4), reports (M5).
 */
export const apiRouter: Router = Router()

apiRouter.use(healthRouter)
