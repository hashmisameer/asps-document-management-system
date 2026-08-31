import os from 'node:os'
import path from 'node:path'

/**
 * Environment for the test run, applied before any module is imported.
 *
 * config/env.ts validates the environment at import time and refuses to load
 * without a database and session configuration, so the values below stand in
 * for it. They are deliberately unusable: the host does not resolve to a real
 * server and the secret is not a real secret, so a test can never touch a live
 * database by accident.
 *
 * dotenv does not override variables that are already set, so a developer's own
 * backend/.env cannot leak into a test run either.
 */
const scratch = path.join(os.tmpdir(), 'asps-dms-test')

process.env.NODE_ENV = 'test'
process.env.DB_HOST = 'localhost.invalid'
process.env.DB_NAME = 'ASPS_DMS_TEST'
process.env.DB_USER = 'test-user'
process.env.DB_PASSWORD = 'test-password'
process.env.SESSION_SECRET = 'test-session-secret-not-used-for-anything-real-0123456789'
process.env.DOCUMENT_STORAGE_PATH = path.join(scratch, 'storage')
process.env.LOG_DIR = path.join(scratch, 'logs')
process.env.LOG_LEVEL = 'error'
process.env.CORS_ORIGIN = ''
