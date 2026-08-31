/**
 * Database CLI.
 *
 *   npm run db:status       - list migrations and whether each has been applied
 *   npm run db:migrate      - apply all pending migrations
 *   npm run db:seed         - apply seed data (idempotent)
 *   npm run db:create-user  - create a login (first admin, or a new user)
 *
 * Exits non-zero on failure so it can be used in a deployment script.
 */
import { ALL_ROLES, passwordSchema, type Role } from '@asps-dms/shared'
import * as userRepository from '../repositories/user.repository.js'
import { generateTemporaryPassword, hashPassword } from '../services/password.service.js'
import { closePool, getPool } from './pool.js'
import { getStatus, runMigrations, runSeeds } from './migrate.js'

type Command = 'status' | 'migrate' | 'seed' | 'check' | 'create-user'

const COMMANDS: readonly Command[] = ['status', 'migrate', 'seed', 'check', 'create-user']

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

/**
 * Reads --flag value pairs. Deliberately minimal: this is an operator tool run
 * by hand a handful of times, not a user interface.
 */
function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token?.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Flag ${token} needs a value`)
      }
      flags.set(token.slice(2), value)
      index += 1
    }
  }
  return flags
}

function isRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value)
}

async function createUser(argv: string[]): Promise<void> {
  const flags = readFlags(argv)
  const username = flags.get('username')?.trim()
  const fullName = flags.get('name')?.trim()
  const role = flags.get('role')?.trim().toUpperCase()

  if (!username || !fullName || !role) {
    throw new Error(
      'Usage: npm run db:create-user -- --username <name> --name "<full name>" ' +
        `--role <${ALL_ROLES.join('|')}> [--password <password>]`,
    )
  }
  if (!isRole(role)) {
    throw new Error(`Unknown role '${role}'. Expected one of: ${ALL_ROLES.join(', ')}`)
  }
  if (username.length > 100) throw new Error('Username must be 100 characters or fewer')
  if (fullName.length > 150) throw new Error('Full name must be 150 characters or fewer')

  if (await userRepository.usernameExists(username)) {
    throw new Error(`A user named '${username}' already exists`)
  }

  // A password passed on the command line lands in the shell history, so the
  // generated one is the recommended path and the flag exists only for scripts.
  const supplied = flags.get('password')
  const password = supplied ?? generateTemporaryPassword()

  const policy = passwordSchema.safeParse(password)
  if (!policy.success) {
    const reasons = policy.error.issues.map((issue) => `  - ${issue.message}`).join('\n')
    throw new Error(`Password does not meet the policy:\n${reasons}`)
  }

  const userId = await userRepository.createUser({
    username,
    fullName,
    role,
    password: await hashPassword(password),
    // Always: the person running this command must not end up knowing the
    // password the user ends up with.
    mustChangePassword: true,
  })

  console.log(`Created user #${userId}`)
  console.log(`  Username : ${username}`)
  console.log(`  Full name: ${fullName}`)
  console.log(`  Role     : ${role}`)
  if (!supplied) {
    console.log(`\n  Temporary password: ${password}`)
    console.log(
      '\n  Shown once and not stored anywhere in this form. Hand it over in person,\n' +
        '  not by email or chat. The user must change it at first sign-in.',
    )
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (!isCommand(command)) {
    console.error(`Usage: tsx src/database/cli.ts <${COMMANDS.join('|')}> [flags]`)
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
    case 'create-user': {
      await createUser(process.argv.slice(3))
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
