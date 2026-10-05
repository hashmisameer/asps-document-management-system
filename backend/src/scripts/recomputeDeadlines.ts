/**
 * Puts deadlines back in step with the joining dates they are computed from.
 *
 *   npm run recompute-deadlines -- --dry-run
 *   npm run recompute-deadlines
 *   npm run recompute-deadlines -- --limit 100 --as <username>
 *
 * A deadline is the joining date plus the document type's allowance, written
 * when the checklist is created. Nothing recomputed it until now, so an
 * employee whose joining date was corrected afterwards kept the deadlines of
 * the date that was wrong: three employees had a date of birth typed into the
 * joining date and were being chased against 1988, 1989, 1993 and 2009.
 *
 * This finds EVERY employee whose outstanding documents disagree with their
 * current joining date - not a list of codes - and puts each one right, with a
 * DEADLINE_CHANGED entry per document saying what moved it.
 *
 * ONLY DOCUMENTS WITH NO FILE. One that has arrived keeps the date that applied
 * to it, which is the line migrations 0023 and 0034 drew.
 *
 * A DEADLINE SOMEBODY SET BY HAND IS MOVED TOO, and said so. HR can extend one
 * document's deadline, and nothing on the row marks it as deliberate - so this
 * cannot tell a kind extension from a stale date. It moves both and lists the
 * overwritten ones separately, because an override that disappears quietly is
 * worse than one that disappears in the open.
 *
 * IT NAMES THE EMPLOYEE CODE, unlike stamp-check and auto-stamp. This is a
 * repair tool: whoever runs it has to know whose record is being corrected.
 *
 * Flags:
 *   --dry-run         print what would change; change nothing
 *   --limit <n>       at most n documents (default 2000)
 *   --as <username>   whose name the audit entries carry. Defaults to the
 *                     first active administrator
 */
import { ROLES, type AuthUser } from '@asps-dms/shared'
import { closePool } from '../database/pool.js'
import * as userRepository from '../repositories/user.repository.js'
import {
  applyMoves,
  planForEveryone,
  type DeadlineMove,
} from '../services/deadlineRecompute.service.js'
import { describeError } from '../utils/errors.js'

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const next = argv[i + 1]
    const value = next && !next.startsWith('--') ? next : 'true'
    flags.set(arg.slice(2), value)
    if (value !== 'true') i += 1
  }
  return flags
}

async function resolveActor(username: string | undefined): Promise<AuthUser> {
  if (username) {
    const user = await userRepository.findByUsername(username)
    if (!user) throw new Error(`There is no user named '${username}'`)
    return userRepository.toAuthUser(user)
  }
  const admin = await userRepository.findFirstByRole(ROLES.ADMIN)
  if (!admin) {
    throw new Error(
      'No administrator account exists for the audit trail to name.\n' +
        '  Name one:  npm run recompute-deadlines -- --as <username>',
    )
  }
  return userRepository.toAuthUser(admin)
}

/** '#412  00006135  PF Form / Form 11   1988-09-14 -> 2026-09-13' */
function line(move: DeadlineMove): string {
  return (
    `#${String(move.documentId).padEnd(6)} ${move.employeeCode}  ` +
    `${move.documentName.padEnd(26)} ${String(move.from ?? 'none').padEnd(12)} -> ${move.to ?? 'none'}` +
    (move.wasOverridden ? '   (overwrites a deadline set by hand)' : '')
  )
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const dryRun = flags.get('dry-run') === 'true'
  const limit = flags.has('limit') ? Number(flags.get('limit')) : 2000
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a whole number')

  const moves = await planForEveryone(limit)

  console.log(
    `Deadlines out of step with their joining date: ${moves.length} document(s)` +
      (moves.length === limit ? ` (stopped at ${limit}; pass --limit for more)` : '') +
      (dryRun ? '\nDry run: nothing will be changed.' : '') +
      '\n',
  )

  if (moves.length === 0) {
    console.log('Every outstanding document already agrees with its employee’s joining date.')
    return
  }

  for (const move of moves) console.log(line(move))

  const employees = new Set(moves.map((move) => move.employeeCode))
  const overwritten = moves.filter((move) => move.wasOverridden)
  console.log(
    `\n${moves.length} deadline(s) across ${employees.size} employee(s)` +
      `: ${[...employees].join(', ')}`,
  )

  // Said apart, and said whether or not this is a dry run: a deadline a person
  // chose is the one thing here somebody may want to put back by hand.
  if (overwritten.length > 0) {
    console.log(
      `\n${overwritten.length} of those had been set by hand and ${dryRun ? 'would be' : 'were'} overwritten:`,
    )
    for (const move of overwritten) {
      console.log(`  #${move.documentId}  ${move.employeeCode}  ${move.documentName}`)
    }
  }

  if (dryRun) {
    console.log('\nDry run: nothing was changed.')
    return
  }

  const actor = await resolveActor(flags.get('as'))
  const written = await applyMoves(moves, {
    actor,
    context: { ipAddress: null, userAgent: 'recompute-deadlines command' },
    reason: 'recomputed from the employee’s joining date',
  })

  console.log(`\n${written} deadline(s) moved, in the name of ${actor.username}.`)
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
