import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { httpLogger } from './middleware/httpLogger.js'
import { apiLimiter } from './middleware/rateLimit.js'
import { requestId } from './middleware/requestId.js'
import { apiRouter } from './routes/index.js'

/**
 * Builds the Express application.
 *
 * Separated from server.ts so tests can exercise the whole middleware stack
 * over an ephemeral port without opening the configured one, and so nothing
 * about listening, signals or shutdown leaks into request handling.
 *
 * Order matters and is not incidental:
 *   requestId  -> every later line of logging can be correlated
 *   httpLogger -> a request that is rejected by a later guard is still logged
 *   helmet     -> headers are set even on an error response
 *   parsers    -> a malformed body becomes a 400 through the error handler
 *   router     -> the application itself
 *   404 + error handler -> always last
 */
export function createApp(): Express {
  const app = express()

  // The app is reached directly on the LAN, not through a reverse proxy. Left
  // false deliberately: trusting X-Forwarded-For when nothing sets it would let
  // any client spoof its own IP and defeat the rate limiter and the audit log.
  app.set('trust proxy', false)
  app.disable('x-powered-by')
  // '/api/employees' and '/api/employees/' are the same route, not two.
  app.set('strict routing', false)

  app.use(requestId)
  app.use(httpLogger)

  app.use(
    helmet({
      // The SPA is served from a separate origin in development and by a static
      // host in production; this API returns JSON and files, never HTML, so a
      // content security policy here would only constrain documents it does not
      // serve. It is configured where the HTML is served instead.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  )

  if (env.corsOrigins.length > 0) {
    // Only the development Vite origin needs this. In production the SPA is
    // same-origin, CORS_ORIGIN is empty, and no CORS headers are sent at all.
    app.use(
      cors({
        origin: env.corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
      }),
    )
  }

  // Uploads arrive as multipart and are handled by multer per-route, so the
  // JSON and form limits here can stay small: no legitimate JSON body in this
  // application is anywhere near 100 kB.
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: false, limit: '100kb' }))
  app.use(cookieParser(env.SESSION_SECRET))

  app.use('/api', apiLimiter, apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
