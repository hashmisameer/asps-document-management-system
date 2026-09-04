import type { Server } from 'node:http'
import { createApp } from './app.js'
import { env } from './config/env.js'
import { closePool, getPool } from './database/pool.js'
import { closeOcrWorker } from './services/documentText.service.js'
import { ensureStorageReady } from './services/storage.service.js'
import { startDailyReport, stopDailyReport } from './services/reportSchedule.service.js'
import { logger } from './utils/logger.js'
import { describeError } from './utils/errors.js'

/**
 * Process entry point: listen, then shut down cleanly.
 *
 * A shutdown that drops in-flight requests is not acceptable here - one of
 * them may be halfway through writing a document to disk and its row to the
 * database. On a signal the listener stops accepting new connections, existing
 * requests are given time to finish, and only then is the pool closed.
 */

const SHUTDOWN_GRACE_MS = 10_000

/**
 * Opens the pool at boot so a bad DB_* value is reported on the first line of
 * output rather than by the first user to click something.
 *
 * A failure here does NOT stop the process: the database being unreachable is
 * an operational condition the readiness endpoint reports, and a server that
 * refuses to boot cannot tell anyone why. It retries on the next request.
 */
async function warmUpDatabase(): Promise<void> {
  try {
    await getPool()
  } catch (err) {
    logger.error(
      { err },
      `Could not connect to SQL Server at startup: ${describeError(err)}. ` +
        `The API is listening; /api/health/ready will report unavailable until it connects.`,
    )
  }
}

/**
 * Creates the document store if it is missing.
 *
 * Like the database warm-up, a failure here is logged rather than fatal: an
 * unwritable storage volume stops uploads, not sign-ins or the readiness
 * endpoint that would explain the problem. /api/health/ready reports it.
 */
async function warmUpStorage(): Promise<void> {
  try {
    await ensureStorageReady()
  } catch (err) {
    logger.error(
      { err },
      `Could not prepare the document storage folder: ${describeError(err)}. ` +
        `Uploads will fail until DOCUMENT_STORAGE_PATH exists and is writable.`,
    )
  }
}

function registerShutdown(server: Server): void {
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Shutting down')

    // A request that hangs must not keep the process alive forever; after the
    // grace period the process exits non-zero so a service manager restarts it.
    const forceExit = setTimeout(() => {
      logger.error({ graceMs: SHUTDOWN_GRACE_MS }, 'Shutdown timed out; exiting')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    forceExit.unref()

    server.close((closeError) => {
      const finish = async (): Promise<void> => {
        try {
          stopDailyReport()
          await closePool()
        } catch (err) {
          logger.error({ err }, 'Failed to close the SQL Server pool')
        }
        // The OCR worker is a separate process with its own threads, and it
        // holds this one open on its own. Without this the shutdown never
        // finished: it ran to the grace timeout every time, and because the
        // listening socket is only released when the process actually dies,
        // the replacement started meanwhile died on EADDRINUSE. In development
        // that is a restart loop on every file save; on the server it is a
        // service that fails to come back after a deploy.
        try {
          await closeOcrWorker()
        } catch (err) {
          logger.error({ err }, 'Failed to close the OCR worker')
        }
        clearTimeout(forceExit)
        process.exit(closeError ? 1 : 0)
      }
      void finish()
    })

    // server.close() stops new connections but waits for open ones, and a
    // browser keeps its keep-alive sockets open with nothing on them. Those
    // idle sockets alone were enough to hold the port past the grace period.
    server.closeAllConnections()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Windows services and `npm run dev` both send this.
  process.on('SIGHUP', () => shutdown('SIGHUP'))

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, `Unhandled promise rejection: ${describeError(reason)}`)
  })

  process.on('uncaughtException', (err) => {
    // State is unknown after an uncaught exception, so this one does exit.
    logger.fatal({ err }, `Uncaught exception: ${describeError(err)}`)
    shutdown('uncaughtException')
  })
}

async function main(): Promise<void> {
  const app = createApp()

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { host: env.HOST, port: env.PORT, environment: env.NODE_ENV },
      `ASPS-DMS API listening on http://${env.HOST}:${env.PORT}`,
    )
  })

  server.on('error', (err) => {
    logger.fatal({ err }, `Could not start the server: ${describeError(err)}`)
    process.exit(1)
  })

  registerShutdown(server)
  await warmUpDatabase()
  await warmUpStorage()

  // The daily report. Armed after the database is warm, because the first thing
  // it does is read the outstanding documents.
  startDailyReport()
}

void main()
