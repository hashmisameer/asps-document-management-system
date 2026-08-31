import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import { logger } from '../utils/logger.js'

/**
 * One log line per request.
 *
 * Redaction of cookies, authorization headers and password-shaped fields is
 * configured on the logger itself (utils/logger.ts), so it applies here too.
 * Health checks are not logged: they are polled continuously and would bury
 * everything else.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { requestId?: string }).requestId ?? randomUUID(),
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/health/ready',
  },
  customLogLevel: (_req, res, err) => {
    if (err) return 'error'
    if (res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
})
