import { Router } from 'express'
import { env } from '../config/env.js'
import { pingDatabase } from '../database/pool.js'
import { checkStorageWritable } from '../services/storage.service.js'

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
  // Both dependencies are checked, not just the first to fail: an operator
  // fixing one and finding the other broken on the next attempt is a slower
  // way to the same place.
  const [database, storage] = await Promise.all([pingDatabase(), checkStorageWritable()])
  const ready = database.ok && storage.ok

  if (!database.ok) {
    // The driver message names the host and the login; it belongs in the log.
    req.log.error({ err: database.error, latencyMs: database.latencyMs }, 'Readiness check failed')
  }
  if (!storage.ok) {
    // The path is on the server's disk and is not the caller's business.
    req.log.error({ err: storage.error }, 'Document storage is not writable')
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'unavailable',
    checks: {
      database: { ok: database.ok, latencyMs: database.latencyMs },
      storage: { ok: storage.ok },
    },
    timestamp: new Date().toISOString(),
  })
})
