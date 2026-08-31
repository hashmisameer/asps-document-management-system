import sql from 'mssql'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * SQL Server connection pool.
 *
 * One pool for the process lifetime. `mssql` is backed by Tedious, a pure
 * JavaScript TDS implementation, so the company's Windows server needs no ODBC
 * driver and no native build toolchain.
 *
 * SQL Server 2014 + Node 20/22 note: Node ships OpenSSL 3, which refuses the
 * older TLS that a stock SQL Server 2014 offers. On a trusted LAN we connect
 * with DB_ENCRYPT=false and DB_TRUST_SERVER_CERTIFICATE=true.
 * See docs/sql-server-2014-notes.md for the full diagnosis and alternatives.
 */

function buildConfig(): sql.config {
  const config: sql.config = {
    server: env.DB_HOST,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeout: env.DB_CONNECTION_TIMEOUT_MS,
    requestTimeout: env.DB_REQUEST_TIMEOUT_MS,
    pool: {
      max: env.DB_POOL_MAX,
      min: env.DB_POOL_MIN,
      idleTimeoutMillis: 30_000,
    },
    options: {
      encrypt: env.DB_ENCRYPT,
      trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE,
      // Keep DATE / DATETIME2 columns coming back as strings we control,
      // rather than being silently shifted into the server's local timezone.
      useUTC: true,
      enableArithAbort: true,
      appName: 'ASPS-DMS',
    },
  }

  if (env.DB_INSTANCE) {
    // A named instance is resolved by SQL Server Browser; port must be omitted.
    config.options = { ...config.options, instanceName: env.DB_INSTANCE }
  } else {
    config.port = env.DB_PORT
  }

  return config
}

let pool: sql.ConnectionPool | null = null
let connecting: Promise<sql.ConnectionPool> | null = null

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool
  if (connecting) return connecting

  connecting = (async () => {
    const created = new sql.ConnectionPool(buildConfig())

    created.on('error', (err) => {
      // Pool-level errors are asynchronous and must never take the process down.
      logger.error({ err }, 'SQL Server pool error')
    })

    try {
      await created.connect()
      logger.info(
        {
          server: env.DB_HOST,
          database: env.DB_NAME,
          instance: env.DB_INSTANCE ?? null,
          encrypt: env.DB_ENCRYPT,
        },
        'Connected to SQL Server',
      )
      pool = created
      return created
    } finally {
      connecting = null
    }
  })()

  return connecting
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close()
    pool = null
    logger.info('SQL Server pool closed')
  }
}

/**
 * Runs `work` inside a transaction, committing on success and rolling back on
 * any thrown error. Used wherever more than one table must move together -
 * employee creation plus its document checklist, for instance.
 */
export async function withTransaction<T>(
  work: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  const activePool = await getPool()
  const tx = new sql.Transaction(activePool)
  await tx.begin()

  let committed = false
  try {
    const result = await work(tx)
    await tx.commit()
    committed = true
    return result
  } finally {
    if (!committed) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        // A rollback failure must not mask the original error.
        logger.error({ err: rollbackError }, 'Transaction rollback failed')
      }
    }
  }
}

/**
 * A request bound either to the pool or to an open transaction.
 *
 * Repositories take an optional transaction so the same function can be called
 * standalone or as one step of a multi-table write - employee creation and its
 * document checklist, for instance - without a second copy of the query.
 */
export async function createRequest(transaction?: sql.Transaction): Promise<sql.Request> {
  if (transaction) return new sql.Request(transaction)
  const activePool = await getPool()
  return activePool.request()
}

/** Re-exported so repositories never import the driver directly. */
export { sql }

export interface DatabasePing {
  ok: boolean
  latencyMs: number
  /** Present only when ok === false. Logged and shown to operators, not users. */
  error?: string
}

/**
 * Cheapest possible round trip to SQL Server, for the readiness endpoint.
 *
 * Never throws: an unreachable database is a state the caller reports, not an
 * exception it has to catch. A failure here also drops the cached pool so the
 * next call reconnects rather than reusing a dead handle.
 */
export async function pingDatabase(): Promise<DatabasePing> {
  const startedAt = Date.now()
  try {
    const activePool = await getPool()
    await activePool.request().query('SELECT 1 AS Ok')
    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch (err) {
    pool = null
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
