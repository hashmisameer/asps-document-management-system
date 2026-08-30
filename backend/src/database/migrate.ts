import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { getPool, sql } from './pool.js'

/**
 * Forward-only SQL migration runner.
 *
 * Deliberately hand-rolled rather than delegated to an ORM: the production
 * database is SQL Server 2014, and a generated schema is exactly how a 2016+
 * construct slips in unnoticed. Here, every statement that reaches the server
 * is one we wrote and reviewed.
 *
 * Each file is applied once, inside a transaction, and recorded in
 * dbo.SchemaMigrations with a checksum. Editing an already-applied migration is
 * treated as an error rather than silently ignored - the fix is a new file.
 */

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'database',
  'migrations',
)

const seedsDir = path.resolve(migrationsDir, '..', 'seeds')

interface MigrationFile {
  name: string
  fullPath: string
  sqlText: string
  checksum: string
}

export interface AppliedMigration {
  name: string
  checksum: string
  appliedAt: Date
}

const CREATE_TRACKING_TABLE = `
IF OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.SchemaMigrations
    (
        MigrationName VARCHAR(200)  NOT NULL,
        Checksum      CHAR(64)      NOT NULL,
        AppliedAt     DATETIME2(3)  NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_SchemaMigrations PRIMARY KEY CLUSTERED (MigrationName)
    );
END`

function checksumOf(text: string): string {
  // Normalise line endings so a Windows/Unix checkout does not look modified.
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

async function readSqlFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const files = entries.filter((f) => f.toLowerCase().endsWith('.sql')).sort()

  return Promise.all(
    files.map(async (name) => {
      const fullPath = path.join(dir, name)
      const sqlText = await fs.readFile(fullPath, 'utf8')
      return { name, fullPath, sqlText, checksum: checksumOf(sqlText) }
    }),
  )
}

/**
 * Splits a script on batch separators.
 *
 * GO is a client-side batch separator understood by sqlcmd and SSMS, not T-SQL
 * the server accepts, so it must be stripped and each batch sent separately.
 * Only a GO alone on its own line counts - never one inside a string or comment.
 */
function splitBatches(sqlText: string): string[] {
  return sqlText
    .split(/^[ \t]*GO[ \t]*(?:--.*)?$/gim)
    .map((batch) => batch.trim())
    .filter((batch) => batch.length > 0)
}

async function ensureTrackingTable(): Promise<void> {
  const pool = await getPool()
  await pool.request().batch(CREATE_TRACKING_TABLE)
}

export async function getAppliedMigrations(): Promise<AppliedMigration[]> {
  await ensureTrackingTable()
  const pool = await getPool()
  const result = await pool
    .request()
    .query<{ MigrationName: string; Checksum: string; AppliedAt: Date }>(
      'SELECT MigrationName, Checksum, AppliedAt FROM dbo.SchemaMigrations ORDER BY MigrationName',
    )
  return result.recordset.map((r) => ({
    name: r.MigrationName,
    checksum: r.Checksum,
    appliedAt: r.AppliedAt,
  }))
}

export interface MigrationStatus {
  name: string
  state: 'applied' | 'pending' | 'modified'
  appliedAt: Date | null
}

export async function getStatus(): Promise<MigrationStatus[]> {
  const [files, applied] = await Promise.all([readSqlFiles(migrationsDir), getAppliedMigrations()])
  const appliedByName = new Map(applied.map((a) => [a.name, a]))

  return files.map((file) => {
    const record = appliedByName.get(file.name)
    if (!record) return { name: file.name, state: 'pending' as const, appliedAt: null }
    if (record.checksum !== file.checksum) {
      return { name: file.name, state: 'modified' as const, appliedAt: record.appliedAt }
    }
    return { name: file.name, state: 'applied' as const, appliedAt: record.appliedAt }
  })
}

export async function runMigrations(): Promise<string[]> {
  const files = await readSqlFiles(migrationsDir)
  if (files.length === 0) {
    logger.warn({ migrationsDir }, 'No migration files found')
    return []
  }

  const applied = await getAppliedMigrations()
  const appliedByName = new Map(applied.map((a) => [a.name, a]))

  // A changed checksum means an already-applied file was edited. Applying it
  // again would not undo what the previous version did, so stop and say so.
  for (const file of files) {
    const record = appliedByName.get(file.name)
    if (record && record.checksum !== file.checksum) {
      throw new Error(
        `Migration '${file.name}' has been modified since it was applied on ` +
          `${record.appliedAt.toISOString()}. Migrations are forward-only: ` +
          `revert the edit and add a new migration file instead.`,
      )
    }
  }

  const pending = files.filter((f) => !appliedByName.has(f.name))
  if (pending.length === 0) {
    logger.info('Database is up to date; no pending migrations')
    return []
  }

  const pool = await getPool()
  const executed: string[] = []

  for (const file of pending) {
    const transaction = new sql.Transaction(pool)
    await transaction.begin()
    let committed = false

    try {
      for (const batch of splitBatches(file.sqlText)) {
        await new sql.Request(transaction).batch(batch)
      }

      await new sql.Request(transaction)
        .input('name', sql.VarChar(200), file.name)
        .input('checksum', sql.Char(64), file.checksum)
        .query(
          'INSERT INTO dbo.SchemaMigrations (MigrationName, Checksum) VALUES (@name, @checksum)',
        )

      await transaction.commit()
      committed = true
      executed.push(file.name)
      logger.info({ migration: file.name }, 'Migration applied')
    } catch (err) {
      if (!committed) {
        try {
          await transaction.rollback()
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'Migration rollback failed')
        }
      }
      throw new Error(
        `Migration '${file.name}' failed: ${(err as Error).message}. ` +
          `No changes from this file were kept.`,
      )
    }
  }

  return executed
}

/**
 * Seeds are re-runnable by design: each one is written to be idempotent
 * (insert-if-absent), so running them twice does not duplicate rows.
 */
export async function runSeeds(): Promise<string[]> {
  const files = await readSqlFiles(seedsDir)
  if (files.length === 0) {
    logger.warn({ seedsDir }, 'No seed files found')
    return []
  }

  if (env.isProduction) {
    // Development seed data must never reach the company's production database.
    const devSeeds = files.filter((f) => f.name.includes('dev'))
    if (devSeeds.length > 0) {
      throw new Error(
        `Refusing to run development seed files in production: ${devSeeds
          .map((f) => f.name)
          .join(', ')}`,
      )
    }
  }

  const pool = await getPool()
  const executed: string[] = []

  for (const file of files) {
    for (const batch of splitBatches(file.sqlText)) {
      await pool.request().batch(batch)
    }
    executed.push(file.name)
    logger.info({ seed: file.name }, 'Seed applied')
  }

  return executed
}

export const __testing = { splitBatches, checksumOf }
