/**
 * Imports the employee master from a spreadsheet.
 *
 *   npm run import-employees -- --file <path> --dry-run
 *   npm run import-employees -- --file <path>
 *
 * The dry run reads the whole file, checks every row against the same rules
 * the Add Employee form uses, and prints what WOULD happen. It touches
 * nothing. Run it first, fix what it complains about, and run it again.
 *
 * Flags:
 *   --file <path>       the CSV to read. Required.
 *   --dry-run           report only; nothing is written
 *   --date-format mdy   how to read '4/11/2022'. mdy (default) or dmy
 *   --strict            treat a dropped optional detail as a failed row
 *   --as <username>     whose name the records are created in. Defaults to the
 *                       first active administrator
 *   --limit <n>         stop after n rows, for a cautious first run
 *
 * Reads .xlsx and .csv. The .xlsx reader is ours - see utils/xlsx.ts - because
 * the server has no route to a registry and every dependency is a file
 * somebody has to carry to it.
 *
 * Every employee is created through the application's own service, so each one
 * gets the checklist and the deadlines they would have got if somebody had
 * typed them into the form - the same ten documents, dated from the same
 * joining date, in the same transaction.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROLES, type AuthUser } from '@asps-dms/shared'
import { closePool } from '../database/pool.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import * as employeeService from '../services/employee.service.js'
import {
  planImport,
  readRows,
  readTable,
  type DateFormat,
  type RowPlan,
} from '../services/employeeImport.service.js'
import { describeError } from '../utils/errors.js'

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      const next = argv[i + 1]
      const value = next && !next.startsWith('--') ? next : 'true'
      flags.set(arg.slice(2), value)
      if (value !== 'true') i += 1
    }
  }
  return flags
}

/**
 * Whose name the records are created in.
 *
 * Every employee written here lands in the audit trail against a real user, so
 * 'who added these 568 people' has an answer. An import that recorded nobody
 * would be the one entry in that trail nobody could account for.
 */
async function resolveActor(username: string | undefined): Promise<AuthUser> {
  if (username) {
    const user = await userRepository.findByUsername(username)
    if (!user) throw new Error(`There is no user named '${username}'`)
    return userRepository.toAuthUser(user)
  }

  const admin = await userRepository.findFirstByRole(ROLES.ADMIN)
  if (!admin) {
    throw new Error(
      'No administrator account exists to import as.\n' +
        '  Create one first:  npm run user:add -- --username <name> --name "<full name>" --role ADMIN\n' +
        '  Or name a user:    npm run import-employees -- --file <path> --as <username>',
    )
  }
  return userRepository.toAuthUser(admin)
}

/** One line per row, in the order the file has them. */
function describe(plan: RowPlan): string {
  const who = `line ${plan.line}  ${plan.employeeCode.padEnd(10)} ${plan.employeeName}`
  if (plan.errors.length > 0) return `${who}\n    FAILED: ${plan.errors.join('; ')}`
  if (plan.duplicate) return `${who}\n    SKIPPED: already ${plan.duplicate}`
  if (plan.warnings.length > 0) return `${who}\n    WARNING: ${plan.warnings.join('; ')}`
  return who
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const file = flags.get('file')

  if (!file || file === 'true') {
    throw new Error(
      'Usage: npm run import-employees -- --file <path> [--dry-run] [--date-format mdy|dmy] [--strict] [--as <username>] [--limit <n>]',
    )
  }

  const dryRun = flags.get('dry-run') === 'true'
  const strict = flags.get('strict') === 'true'
  const format = (flags.get('date-format') ?? 'mdy') as DateFormat
  if (format !== 'mdy' && format !== 'dmy') {
    throw new Error(`--date-format must be 'mdy' or 'dmy', not '${format}'`)
  }

  const limit = flags.has('limit') ? Number(flags.get('limit')) : Number.POSITIVE_INFINITY
  if (Number.isNaN(limit) || limit <= 0) throw new Error('--limit must be a positive number')

  const contents = await fs.readFile(path.resolve(file))
  const { rows, missingColumns } = readRows(readTable(file, contents))

  if (missingColumns.length > 0) {
    throw new Error(
      `The file is missing these columns: ${missingColumns.join(', ')}\n` +
        '  The first line must be the header row from the template.',
    )
  }
  if (rows.length === 0) throw new Error('The file has a header and no rows.')

  const existingCodes = await employeeRepository.allEmployeeCodes()
  const plan = planImport(rows.slice(0, limit), existingCodes, { format, strict })

  console.log(`\n${path.basename(file)} - ${rows.length} row(s)`)
  console.log(
    `Dates read as ${format === 'mdy' ? 'MONTH/day/year' : 'DAY/month/year'}. ` +
      `First joining date: ${plan.rows[0]?.input?.joiningDate ?? 'unreadable'} (from '${rows[0]?.values.joining_date ?? ''}')`,
  )
  console.log(`Already in the database: ${existingCodes.size} employee(s)\n`)

  for (const row of plan.rows) {
    if (row.errors.length > 0 || row.duplicate || row.warnings.length > 0) {
      console.log(describe(row))
    }
  }

  console.log(
    `\n  to import : ${plan.create.length}` +
      `\n  to skip   : ${plan.skip.length}  (already there)` +
      `\n  failed    : ${plan.fail.length}` +
      `\n  warnings  : ${plan.create.filter((row) => row.warnings.length > 0).length}\n`,
  )

  if (dryRun) {
    console.log('Dry run: nothing was written.')
    if (plan.fail.length > 0) {
      console.log('Fix the failed rows and run it again - or import without them.')
    }
    return
  }

  const actor = await resolveActor(flags.get('as'))
  console.log(`Importing as ${actor.username} (${actor.fullName})...\n`)

  let imported = 0
  const refused: string[] = []

  for (const row of plan.create) {
    if (!row.input) continue
    try {
      await employeeService.create(row.input, actor, { ipAddress: null, userAgent: 'import' })
      imported += 1
      if (imported % 25 === 0) console.log(`  ${imported} of ${plan.create.length}...`)
    } catch (error) {
      // One employee the database would not take does not stop the other 567.
      refused.push(`line ${row.line}  ${row.employeeCode}: ${describeError(error)}`)
    }
  }

  console.log(`\n  imported : ${imported}`)
  console.log(`  skipped  : ${plan.skip.length}  (already there)`)
  console.log(`  failed   : ${plan.fail.length + refused.length}`)

  if (refused.length > 0) {
    console.log('\nRefused by the database:')
    for (const line of refused) console.log(`  ${line}`)
  }

  console.log(
    '\nEach imported employee has the full document checklist, with deadlines from their joining date.',
  )
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
