/**
 * Database CLI.
 *
 *   npm run db:status    - list migrations and whether each has been applied
 *   npm run db:migrate   - apply all pending migrations
 *   npm run db:seed      - apply seed data (idempotent)
 *
 * Exits non-zero on failure so it can be used in a deployment script.
 */
import { closePool, getPool } from './pool.js'
import { getStatus, runMigrations, runSeeds } from './migrate.js'

type Command = 'status' | 'migrate' | 'seed' | 'check'

const COMMANDS: readonly Command[] = ['status', 'migrate', 'seed', 'check']

function isCommand(value: string | undefined): value is Command {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value)
}

async function checkConnection(): Promise<void> {
  const pool = await getPool()
  const result = await pool.request().query<{
    Version: string
    ProductLevel: string
    Edition: string
    CompatibilityLevel: number
    DatabaseName: string
  }>(`
    SELECT
        CAST(SERVERPROPERTY('ProductVersion') AS VARCHAR(50)) AS Version,
        CAST(SERVERPROPERTY('ProductLevel')   AS VARCHAR(50)) AS ProductLevel,
        CAST(SERVERPROPERTY('Edition')        AS VARCHAR(100)) AS Edition,
        d.compatibility_level                                  AS CompatibilityLevel,
        DB_NAME()                                              AS DatabaseName
    FROM sys.databases AS d
    WHERE d.database_id = DB_ID()`)

  const row = result.recordset[0]
  if (!row) throw new Error('Connected, but the server returned no version information')

  const majorVersion = Number(row.Version.split('.')[0])

  console.log('Connected to SQL Server')
  console.log(`  Database           : ${row.DatabaseName}`)
  console.log(`  Product version    : ${row.Version} (${row.ProductLevel})`)
  console.log(`  Edition            : ${row.Edition}`)
  console.log(`  Compatibility level: ${row.CompatibilityLevel}`)

  // SQL Server 2014 is major version 12. Anything newer still works, but the
  // point of this project is that the schema stays 2014-compatible, so say so.
  if (majorVersion > 12) {
    console.warn(
      `\n  WARNING: this server is newer than SQL Server 2014 (major version ${majorVersion}).\n` +
        `  Production targets SQL Server 2014. Newer T-SQL used here may pass locally\n` +
        `  and then fail in production. Prefer developing against SQL Server 2014.`,
    )
  } else if (majorVersion < 12) {
    console.warn(
      `\n  WARNING: this server is OLDER than SQL Server 2014 (major version ${majorVersion}).`,
    )
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (!isCommand(command)) {
    console.error(`Usage: tsx src/database/cli.ts <${COMMANDS.join('|')}>`)
    process.exitCode = 1
    return
  }

  switch (command) {
    case 'check': {
      await checkConnection()
      break
    }
    case 'status': {
      await checkConnection()
      const status = await getStatus()
      if (status.length === 0) {
        console.log('\nNo migration files found.')
        break
      }
      console.log('\nMigrations:')
      for (const item of status) {
        const marker =
          item.state === 'applied' ? '[applied]' : item.state === 'pending' ? '[pending]' : '[MODIFIED]'
        const when = item.appliedAt ? ` ${item.appliedAt.toISOString()}` : ''
        console.log(`  ${marker.padEnd(11)} ${item.name}${when}`)
      }
      if (status.some((s) => s.state === 'modified')) {
        console.error(
          '\nOne or more applied migrations have been edited. Migrations are ' +
            'forward-only: revert the edit and add a new migration file.',
        )
        process.exitCode = 1
      }
      break
    }
    case 'migrate': {
      await checkConnection()
      const executed = await runMigrations()
      console.log(
        executed.length === 0
          ? '\nNo pending migrations.'
          : `\nApplied ${executed.length} migration(s):\n${executed.map((n) => `  - ${n}`).join('\n')}`,
      )
      break
    }
    case 'seed': {
      const executed = await runSeeds()
      console.log(
        executed.length === 0
          ? 'No seed files found.'
          : `Applied ${executed.length} seed file(s):\n${executed.map((n) => `  - ${n}`).join('\n')}`,
      )
      break
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
