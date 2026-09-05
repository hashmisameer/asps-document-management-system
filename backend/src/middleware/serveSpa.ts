import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express } from 'express'
import { logger } from '../utils/logger.js'

/**
 * Serving the built frontend from the API, in production.
 *
 * One origin, one port, one service. The alternative was IIS in front, and it
 * costs more than it looks: a second thing to configure on the machine, a
 * second place for a path to be wrong, and a proxy in front of an application
 * whose rate limiter and audit trail deliberately do not trust
 * X-Forwarded-For - every request would have been recorded as coming from the
 * proxy.
 *
 * DEVELOPMENT IS UNTOUCHED. Vite serves the SPA on 5173 and proxies /api here,
 * so this is mounted only when NODE_ENV is production; app.ts decides.
 */

/**
 * Where the built SPA is, worked out from this file rather than from the
 * working directory.
 *
 * The service runs `node dist/server.js`, and a Windows service's working
 * directory is whatever somebody typed into the service manager - so
 * process.cwd() is not something to resolve a path against. This file sits at
 * backend/dist/middleware/ once compiled and backend/src/middleware/ in
 * development, and frontend/dist is three levels up from either.
 */
export const DEFAULT_SPA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../frontend/dist',
)

/**
 * Whether a request should fall through to the SPA.
 *
 * Anything under /api is the API's, including a path it does not recognise: an
 * unknown endpoint must answer with the JSON error envelope, not with a page.
 * A client waiting for JSON that receives HTML reports 'unexpected token <',
 * which says nothing about the URL being wrong.
 *
 * Only GET and HEAD. A POST to a path that does not exist is a mistake worth a
 * 404, not an invitation to render the application.
 */
export function isSpaRequest(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname !== '/api' && !pathname.startsWith('/api/')
}

/**
 * Mounts the static files and the single-page fallback.
 *
 * MUST be called after the API router and before the 404 handler. Before the
 * router, every API call would be answered with index.html; after the 404
 * handler, nothing would reach it at all.
 *
 * Returns false when there is nothing to serve, so a deployment that forgot to
 * copy frontend/dist behaves exactly as it did before - a JSON 404 - rather
 * than throwing on the first request for a page.
 */
export function mountSpa(app: Express, spaDir: string = DEFAULT_SPA_DIR): boolean {
  const indexHtml = path.join(spaDir, 'index.html')

  if (!fs.existsSync(indexHtml)) {
    logger.warn(
      { spaDir },
      'No built frontend found, so only the API is being served. Run `npm run build` and copy frontend/dist.',
    )
    return false
  }

  app.use(
    express.static(spaDir, {
      // The fallback below serves index.html, so this does not - one code path
      // for the page, and '/' is not a special case.
      index: false,
      setHeaders: (res, filePath) => {
        // Vite writes a content hash into every asset's name, so a file under
        // /assets can never change under a name that is already cached. Any
        // other file - a favicon, a manifest - is revalidated.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
        }
      },
    }),
  )

  app.use((req, res, next) => {
    if (!isSpaRequest(req.method, req.path)) {
      next()
      return
    }

    // The routes live in the browser: /employees/42 is a page React Router
    // draws, and the server has never heard of it. Without this, refreshing
    // that page - or opening a link to it - is a 404.
    //
    // Never cached. It names the hashed asset files, so a stale copy points a
    // browser at the previous deployment's JavaScript.
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(indexHtml, (error) => {
      if (error) next(error)
    })
  })

  logger.info({ spaDir }, 'Serving the built frontend')
  return true
}
