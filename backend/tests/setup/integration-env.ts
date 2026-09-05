import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

/**
 * Environment for the INTEGRATION run, applied before any module is imported.
 *
 * Unlike the unit run - which points at a host that deliberately does not
 * resolve, so a test can never reach a real server - these tests need a real
 * SQL Server. They borrow the developer's own backend/.env for the connection
 * and then override the database name.
 *
 * THE OVERRIDE IS THE SAFETY. These tests delete rows to get a known starting
 * state, so running them against a working database would destroy it. The name
 * is forced here, and asserted again below, because "it reads the .env" and
 * "it writes to whatever the .env says" are one careless line apart.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The developer's own connection details: host, instance, credentials.
dotenv.config({ path: path.join(backendRoot, '.env') })

/** Deliberately not configurable. A test run picks its own database, always. */
const TEST_DATABASE = 'ASPS_DMS_TEST'

if (!TEST_DATABASE.endsWith('_TEST')) {
  throw new Error('The integration database name must end in _TEST.')
}

const scratch = path.join(os.tmpdir(), 'asps-dms-integration')

process.env.NODE_ENV = 'test'
process.env.DB_NAME = TEST_DATABASE
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? 'integration-session-secret-not-a-real-one-0123456789'
process.env.DOCUMENT_STORAGE_PATH = path.join(scratch, 'storage')
process.env.LOG_DIR = path.join(scratch, 'logs')
process.env.LOG_LEVEL = 'error'
process.env.CORS_ORIGIN = ''

// Off during tests: the digest is exercised by building it, never by sending.
process.env.REMINDER_ENABLED = 'false'
delete process.env.SMTP_HOST
delete process.env.REGISTRATION_SECRET

if (!process.env.DB_HOST) {
  throw new Error(
    'Integration tests need a database. Copy backend/.env.example to backend/.env and ' +
      'fill in DB_HOST (and DB_INSTANCE or DB_PORT) for a local SQL Server.',
  )
}

export { TEST_DATABASE }
