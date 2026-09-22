/**
 * Takes the application's stamp off documents that were signed before it got
 * to them.
 *
 *   npm run unstamp -- --documents 5765,5767,5774 --reason "..." --dry-run
 *   npm run unstamp -- --documents 5765,5767,5774 --reason "..."
 *   npm run unstamp -- --file ids.txt --reason "..." --as <username>
 *
 * MMC prints the employee's signature and the HR stamp on the forms it
 * generates; for a while the application did not know that and stamped the
 * employee's signature a second time. For each document named, this deletes
 * the placement rows and the processed file - so the original MMC file is
 * served again - sets the signature status to Skipped so nothing queues it
 * for stamping again, and writes an audit entry with the reason. All through
 * the application's own code: the same path the editor takes when HR clears a
 * document's placements.
 *
 * REFUSED, AND SAID SO, PER DOCUMENT: any document with a placement a person
 * put there (Manual, Adjusted, Accepted) - a command run from a list of ids is
 * not the place to undo a decision; a document with no placements, or no
 * processed file, or a status Skipped cannot follow from; an id that is no
 * document. The rest of the list is still done, and the exit code is 1 when
 * anything was refused or failed, so a script around this notices.
 *
 * --dry-run prints exactly the same table and changes nothing.
 *
 * Names no employee, like the other commands: document ids, types, statuses,
 * what would go and why not.
 *
 * Flags:
 *   --documents <ids>    comma-separated document ids
 *   --file <path>        a text file of ids, one per line or comma-separated
 *   --reason "<text>"    required: why, in your words, for the audit trail
 *   --dry-run            show what would be done; change nothing
 *   --as <username>      whose name to act in. Defaults to the first active
 *                        administrator
 */
import { readFileSync } from 'node:fs'
import { ROLES, type AuthUser } from '@asps-dms/shared'
import { closePool } from '../database/pool.js'
import * as userRepository from '../repositories/user.repository.js'
import { apply, parseDocumentIds, plan, type UnstampPlan } from '../services/unstamp.service.js'
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
      'No administrator account exists to act in the name of.\n' +
        '  Name one:  npm run unstamp -- ... --as <username>',
    )
  }
  return userRepository.toAuthUser(admin)
}

function printPlan(planned: UnstampPlan): void {
  const id = (n: number) => `#${String(n).padEnd(6)}`
  for (const line of planned.lines) {
    const type = line.document?.documentName ?? '-'
    const status = line.document?.signatureStatus ?? '-'
    const placed =
      line.placements.length === 0
        ? 'no placements'
        : `${line.placements.length} placement(s): ${[...new Set(line.placements.map((p) => p.method))].join(', ')}`
    const file = line.processedFilePath ? 'processed file' : 'no processed file'
    const verdict =
      line.verdict.action === 'remove'
        ? 'REMOVE stamp -> Skipped'
        : `refused: ${line.verdict.reason}`
    console.log(`${id(line.documentId)} ${type.padEnd(28)} ${status.padEnd(16)} ${placed}; ${file}`)
    console.log(`        ${verdict}`)
  }
  console.log(
    `\n${planned.lines.length} document(s): ${planned.toRemove.length} to unstamp, ${planned.refused.length} refused`,
  )
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const dryRun = flags.get('dry-run') === 'true'

  const listed = flags.get('documents')
  const fromFile = flags.get('file')
  if (
    (listed === undefined || listed === 'true') &&
    (fromFile === undefined || fromFile === 'true')
  ) {
    throw new Error('Name the documents: --documents 1,2,3 or --file ids.txt')
  }
  const text = [
    listed && listed !== 'true' ? listed : '',
    fromFile && fromFile !== 'true' ? readFileSync(fromFile, 'utf8') : '',
  ].join(',')
  const documentIds = parseDocumentIds(text)
  if (documentIds.length === 0) throw new Error('No document ids were given')

  const reason = flags.get('reason')
  if (!reason || reason === 'true' || reason.trim().length === 0) {
    throw new Error('--reason is required: say why, for the audit trail')
  }

  console.log(
    `Unstamp: ${documentIds.length} document(s)` +
      (dryRun ? '  (dry run: nothing will change)' : '') +
      `\nreason: ${reason.trim()}\n`,
  )

  const planned = await plan(documentIds)
  printPlan(planned)

  if (dryRun) {
    console.log('\nDry run: nothing was changed.')
    if (planned.refused.length > 0) process.exitCode = 1
    return
  }

  if (planned.toRemove.length === 0) {
    console.log('\nNothing to do.')
    process.exitCode = 1
    return
  }

  const actor = await resolveActor(flags.get('as'))
  console.log(`\nActing as ${actor.username}.\n`)

  const { done, failed } = await apply(planned, {
    reason: reason.trim(),
    actor,
    context: { ipAddress: null, userAgent: 'unstamp command' },
    onEach: (outcome) => {
      if ('error' in outcome) {
        console.log(`#${outcome.documentId}  FAILED: ${describeError(outcome.error)}`)
      } else {
        console.log(
          `#${outcome.documentId}  unstamped: ${outcome.placementsRemoved} placement(s) removed, ` +
            `processed file ${outcome.processedFileRemoved ? 'deleted' : 'was not there'}, now Skipped`,
        )
      }
    },
  })

  console.log(
    `\n${done.length} unstamped, ${failed.length} failed, ${planned.refused.length} refused`,
  )
  if (failed.length > 0 || planned.refused.length > 0) process.exitCode = 1
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
