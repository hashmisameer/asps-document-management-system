import { Router } from 'express'
import { env } from '../config/env.js'
import { pingDatabase } from '../database/pool.js'

/**
 * Liveness and readiness.
 *
 * Split deliberately:
 *   /health       - is the process up? Never touches the database, so it stays
 *                   instant and is safe to poll.
 *   /health/ready - can it actually serve requests? Round-trips to SQL Server
 *                   and answers 503 when it cannot, which is what a deployment
 *                   script or an uptime check should watch.
 *
 * Neither endpoint requires authentication, so neither returns anything an
 * unauthenticated caller should not see: no version numbers, no host names, no
 * connection strings, and no driver message.
 */
export const healthRouter: Router = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'asps-dms-api',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})

healthRouter.get('/health/ready', async (req, res) => {
  const database = await pingDatabase()

  if (!database.ok) {
    // The driver message names the host and the login; it belongs in the log.
    req.log.error({ err: database.error, latencyMs: database.latencyMs }, 'Readiness check failed')
  }

  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? 'ready' : 'unavailable',
    checks: {
      database: { ok: database.ok, latencyMs: database.latencyMs },
    },
    timestamp: new Date().toISOString(),
  })
})
