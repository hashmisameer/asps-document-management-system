import { Router, type RequestHandler } from 'express'
import { authRouter } from './auth.routes.js'
import { documentRouter } from './document.routes.js'
import { documentTypeRouter } from './documentType.routes.js'
import { employeeRouter } from './employee.routes.js'
import { healthRouter } from './health.routes.js'
import { meRouter } from './me.routes.js'
import { requireAuth, requirePasswordChanged } from '../middleware/requireAuth.js'

/**
 * The API router, mounted at /api.
 *
 * Health and auth are mounted before any authentication gate, for the obvious
 * reason that an uptime check and a login form cannot require a session.
 *
 * Every other feature router is mounted UNDER ITS OWN PATH with the gate in
 * front of it, so a new router is authenticated by where it is mounted rather
 * than by each of its routes remembering to ask. The path prefix is what keeps
 * an unknown /api/... path answering a coded 404 instead of a 401: gating with
 * a pathless `use` would put the whole API behind the session, including the
 * routes that do not exist. Documents and signatures (M4) and reports (M5) join
 * the same way.
 */
export const apiRouter: Router = Router()

apiRouter.use(healthRouter)
apiRouter.use(authRouter)

const authenticated: RequestHandler[] = [requireAuth, requirePasswordChanged]

apiRouter.use('/me', ...authenticated, meRouter)
apiRouter.use('/employees', ...authenticated, employeeRouter)
apiRouter.use('/documents', ...authenticated, documentRouter)
apiRouter.use('/document-types', ...authenticated, documentTypeRouter)
