import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import { env } from '../config/env.js'

/**
 * Application logger.
 *
 * Redaction is configured here rather than at each call site, so a secret
 * cannot leak simply because someone forgot to strip it. The paths below cover
 * the shapes these values realistically arrive in: request bodies, headers,
 * config objects and thrown driver errors.
 *
 * Document CONTENTS are never logged - only identifiers, sizes and paths.
 */

const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'passwordSalt',
  'token',
  'tokenHash',
  'sessionToken',
  'secret',
  'SESSION_SECRET',
  'DB_PASSWORD',
  'connectionString',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  'config.password',
  'options.password',
]

fs.mkdirSync(env.logDir, { recursive: true })

const streams: pino.StreamEntry[] = [
  { level: env.LOG_LEVEL, stream: pino.destination({ dest: path.join(env.logDir, 'app.log'), sync: false, mkdir: true }) },
  { level: 'error', stream: pino.destination({ dest: path.join(env.logDir, 'error.log'), sync: false, mkdir: true }) },
]

// Console output in development only: under test it would interleave with the
// reporter and make a passing run look like a failing one.
if (!env.isProduction && !env.isTest) {
  streams.push({ level: env.LOG_LEVEL, stream: process.stdout })
}

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { app: 'asps-dms' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams),
)

export type Logger = typeof logger
