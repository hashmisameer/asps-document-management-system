import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Environment configuration.
 *
 * Validated once, at boot. A missing or malformed value stops the process
 * immediately with a readable message rather than surfacing as a confusing
 * runtime failure hours later.
 *
 * Values are NEVER logged. The failure message names the offending variable
 * and the reason, never its contents.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

dotenv.config({ path: path.join(backendRoot, '.env') })

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    DB_HOST: z.string().min(1, 'DB_HOST is required'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(1433),
    DB_INSTANCE: z.string().min(1).optional(),
    DB_NAME: z.string().min(1, 'DB_NAME is required'),
    DB_USER: z.string().min(1, 'DB_USER is required'),
    DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),
    DB_ENCRYPT: booleanish.default('false'),
    DB_TRUST_SERVER_CERTIFICATE: booleanish.default('true'),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    DB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_POOL_MIN: z.coerce.number().int().min(0).max(100).default(0),

    DOCUMENT_STORAGE_PATH: z.string().min(1, 'DOCUMENT_STORAGE_PATH is required'),

    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters; generate one with crypto.randomBytes(64)'),
    SESSION_COOKIE_NAME: z.string().min(1).default('asps_dms_sid'),
    SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(480),
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    COOKIE_SECURE: booleanish.default('false'),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    CORS_ORIGIN: z.string().default(''),

    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(25),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_DIR: z.string().default('./logs'),
  })
  .superRefine((v, ctx) => {
    // A named instance is resolved by SQL Server Browser, which makes an
    // explicit port meaningless and the combination ambiguous.
    if (v.DB_INSTANCE && process.env.DB_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_INSTANCE'],
        message: 'Set either DB_INSTANCE or DB_PORT, not both',
      })
    }
    if (v.NODE_ENV === 'production' && !v.COOKIE_SECURE && v.COOKIE_SAME_SITE === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SAME_SITE'],
        message: 'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true',
      })
    }
  })

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    // Names and reasons only - never the values.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(
      `Invalid backend environment configuration:\n${problems}\n\n` +
        `Copy backend/.env.example to backend/.env and fill in the missing values.`,
    )
  }

  const env = parsed.data

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    backendRoot,
    /** Storage root is always resolved to an absolute path, never used raw. */
    storageRoot: path.resolve(backendRoot, env.DOCUMENT_STORAGE_PATH),
    logDir: path.resolve(backendRoot, env.LOG_DIR),
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  }
}

export type AppEnv = ReturnType<typeof loadEnv>

export const env: AppEnv = loadEnv()
