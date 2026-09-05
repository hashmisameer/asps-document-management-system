import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { httpLogger } from './middleware/httpLogger.js'
import { apiLimiter } from './middleware/rateLimit.js'
import { requestId } from './middleware/requestId.js'
import { mountSpa } from './middleware/serveSpa.js'
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
 *   SPA        -> only in production, and only after the API has had its turn
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
      /*
       * A policy only where there is a page for it to govern.
       *
       * In development the SPA is served by Vite on another origin, and a
       * policy set here would constrain documents this process does not serve
       * while leaving the real ones alone. In production it serves the page
       * itself, so the policy belongs here.
       *
       * Every directive below is the tightest the application actually runs
       * under, which is not the same as the tightest that can be written:
       *
       *   style-src 'unsafe-inline'  React writes style attributes - the
       *                              dashboard's split bar sets a width - and a
       *                              style attribute is inline style.
       *   img-src data: blob:        signatures are drawn on a canvas and read
       *                              back as data URLs before they are uploaded.
       *   worker-src blob:           pdf.js runs its worker from a bundled file,
       *                              and falls back to a blob when it cannot.
       *   connect-src 'self'         this application talks to nothing else. No
       *                              analytics, no fonts, no CDN.
       */
      contentSecurityPolicy: env.isProduction
        ? {
            useDefaults: false,
            directives: {
              'default-src': ["'self'"],
              'script-src': ["'self'"],
              'style-src': ["'self'", "'unsafe-inline'"],
              'img-src': ["'self'", 'data:', 'blob:'],
              'font-src': ["'self'", 'data:'],
              'connect-src': ["'self'"],
              'worker-src': ["'self'", 'blob:'],
              'object-src': ["'none'"],
              'base-uri': ["'self'"],
              'form-action': ["'self'"],
              'frame-ancestors': ["'none'"],
            },
          }
        : false,
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

  // After the API, so nothing under /api is ever answered with a page, and
  // before the 404 handler, so a page route reaches it at all.
  if (env.isProduction) mountSpa(app)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
