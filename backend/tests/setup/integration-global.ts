import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import sql from 'mssql'

/**
 * Creates the integration database once, before any test file runs.
 *
 * Runs in vitest's global-setup process, which is separate from the workers, so
 * it deliberately does NOT import the application's pool or config. It talks to
 * `master` with the raw driver, creates ASPS_DMS_TEST if it is not there, and
 * leaves migrating it to the per-file setup, which has the application's own
 * runner already loaded.
 *
 * The database is left behind at the end rather than dropped. A failed run is
 * far easier to understand when the rows that failed are still there to look
 * at, and it costs a few megabytes on a developer's laptop.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
dotenv.config({ path: path.join(backendRoot, '.env') })

const TEST_DATABASE = 'ASPS_DMS_TEST'

export async function setup(): Promise<void> {
  if (!process.env.DB_HOST) {
    throw new Error(
      'Integration tests need a database. Fill in backend/.env - see backend/.env.example.',
    )
  }

  const config: sql.config = {
    server: process.env.DB_HOST,
    // Connecting to master, not to the test database: it may not exist yet.
    database: 'master',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
      ...(process.env.DB_INSTANCE ? { instanceName: process.env.DB_INSTANCE } : {}),
    },
    ...(process.env.DB_INSTANCE ? {} : { port: Number(process.env.DB_PORT ?? 1433) }),
  }

  const pool = await new sql.ConnectionPool(config).connect()
  try {
    const existing = await pool
      .request()
      .query<{ Id: number | null }>(`SELECT DB_ID(N'${TEST_DATABASE}') AS Id`)

    if (existing.recordset[0]?.Id != null) return

    try {
      await pool.request().query(`CREATE DATABASE [${TEST_DATABASE}];`)
    } catch {
      // The application's login is deliberately least-privilege - db_owner on
      // its own database and nothing on the server - so it usually cannot
      // create one. That is correct, and not something to fix by widening it.
      // The database is made once, by hand, with an administrator's account.
      throw new Error(
        `The integration database ${TEST_DATABASE} does not exist, and this login ` +
          `cannot create it. Create it once, as an administrator:\n\n` +
          `  sqlcmd -S .\\<instance> -E -Q "CREATE DATABASE ${TEST_DATABASE}"\n` +
          `  sqlcmd -S .\\<instance> -E -d ${TEST_DATABASE} -Q ` +
          `"CREATE USER <db-user> FOR LOGIN <db-user>; ALTER ROLE db_owner ADD MEMBER <db-user>"\n\n` +
          `substituting the DB_USER from backend/.env. The schema itself is ` +
          `applied by the tests.`,
      )
    }
  } finally {
    await pool.close()
  }
}
