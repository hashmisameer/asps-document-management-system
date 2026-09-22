/**
 * Stamping on upload: what it has decided, the documents it never saw, and
 * the ones that waited for an image that came later.
 *
 *   npm run auto-stamp -- --report
 *   npm run auto-stamp -- --report --since 7d
 *   npm run auto-stamp -- --report --since 2026-09-10 --limit 200
 *
 *   npm run auto-stamp -- --backlog --dry-run
 *   npm run auto-stamp -- --backlog
 *   npm run auto-stamp -- --backlog --limit 50 --as <username>
 *
 *   npm run auto-stamp -- --redecide --type ESIC_FORM --dry-run
 *   npm run auto-stamp -- --redecide --type ESIC_FORM
 *   npm run auto-stamp -- --redecide --type ESIC_FORM --limit 100 --as <username>
 *
 * --report prints the decisions recorded so far, newest first, with a summary
 * at the top: how many, by outcome, and the reasons boxes were left alone,
 * most common first. Read-only.
 *
 * --backlog decides about the documents uploaded BEFORE stamping on upload
 * existed. Nothing ever moved those out of PendingDetection, so every one of
 * them sits there and the 'documents to sign' count cannot see them. Each is
 * put through the same runner an upload goes through - in whatever mode
 * AUTO_STAMP is set to - so in report mode they are decided about, recorded
 * and sent to HR, and nothing is stamped. Each is decided in the name of the
 * person who uploaded it, because the HR box is theirs; --as names who to use
 * when that account is gone. --dry-run lists them and changes nothing.
 *
 * --redecide decides again about every document of one type still waiting
 * for a signature - the ones decided in report mode and never stamped, and
 * the ones whose employee had no signature or photograph at the time.
 * Whatever is already on a document is kept and only the roles missing from
 * a page are added; a document with nothing to add is left exactly as it is
 * and listed with the reason. In AUTO_STAMP's mode, like everything else;
 * only a type in AUTO_STAMP_TYPES. --dry-run reads and decides and prints,
 * per document, what would be added, kept and left, and writes nothing.
 *
 * All three name no employee - not a name, not a code, not an id. Document
 * ids, types, outcomes and reasons only. They are meant to be pasted into a
 * message, and a list of who has not signed what is not.
 *
 * Flags:
 *   --report             print the decisions (the default)
 *   --since <when>       '7d' (default), '24h', '30m', or a date 'YYYY-MM-DD'
 *   --backlog            decide about every document still in PendingDetection
 *   --redecide           decide again about the waiting documents of --type
 *   --type <code>        with --redecide: the document type, by code
 *   --dry-run            with --backlog or --redecide: show, write nothing
 *   --as <username>      with --backlog or --redecide: whose name to decide
 *                        in when the uploader's account is gone. Defaults to
 *                        the first active administrator
 *   --limit <n>          at most n decisions or documents (default 500)
 */
import {
  ROLES,
  SIGNER_ROLE_LABEL,
  STAMP_OUTCOME_LABEL,
  type AuthUser,
  type StampBoxDecision,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import { closePool } from '../database/pool.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as stampDecisionRepository from '../repositories/stampDecision.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import {
  formatDecision,
  formatSummary,
  parseSince,
  summarise,
} from '../services/autoStampReport.service.js'
import { redecideType, runBacklog, type RedecideOutcome } from '../services/autoStampRun.service.js'
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

function readLimit(flags: Map<string, string>): number {
  const limit = flags.has('limit') ? Number(flags.get('limit')) : 500
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a whole number')
  return limit
}

async function report(flags: Map<string, string>): Promise<void> {
  const sinceText = flags.get('since') ?? '7d'
  const since = parseSince(sinceText)
  if (!since) {
    throw new Error(`--since must be like 7d, 24h, 30m or 2026-09-10, not '${sinceText}'`)
  }
  const limit = readLimit(flags)

  const rows = await stampDecisionRepository.listSince(since, limit)

  console.log(`Stamping on upload - decisions since ${since.toISOString()}\n`)
  for (const line of formatSummary(summarise(rows))) console.log(line)

  if (rows.length === 0) {
    console.log('\nNo decisions in that time.')
    return
  }

  console.log('')
  for (const row of rows) {
    for (const line of formatDecision(row)) console.log(line)
  }
  if (rows.length === limit) {
    console.log(`\n(stopped at ${limit}; pass --limit for more)`)
  }
}

/**
 * Whose name a backlog document is decided in when its uploader is gone.
 *
 * The HR box carries the actor's signature, so this is not a formality: in
 * stamp mode the fallback account's signature is what goes on. An
 * administrator's by default, and a named account when told.
 */
async function resolveFallback(username: string | undefined): Promise<AuthUser> {
  if (username) {
    const user = await userRepository.findByUsername(username)
    if (!user) throw new Error(`There is no user named '${username}'`)
    return userRepository.toAuthUser(user)
  }
  const admin = await userRepository.findFirstByRole(ROLES.ADMIN)
  if (!admin) {
    throw new Error(
      'No administrator account exists to decide in the name of.\n' +
        '  Name one:  npm run auto-stamp -- --backlog --as <username>',
    )
  }
  return userRepository.toAuthUser(admin)
}

async function backlog(flags: Map<string, string>): Promise<void> {
  const dryRun = flags.get('dry-run') === 'true'
  const limit = readLimit(flags)

  const rows = await employeeDocumentRepository.listSignatureBacklog(limit)
  console.log(
    `Stamping on upload - backlog: ${rows.length} document(s) still in PendingDetection` +
      (rows.length === limit ? ` (stopped at ${limit})` : '') +
      `\nAUTO_STAMP=${env.AUTO_STAMP}: ` +
      (env.AUTO_STAMP === 'stamp'
        ? 'documents that match a template WILL be stamped.'
        : 'decisions are recorded and nothing is stamped.') +
      `\nAUTO_STAMP_TYPES=${[...env.AUTO_STAMP_TYPES].join(',') || '(empty: no type is stamped)'}` +
      '\n',
  )

  if (rows.length === 0) {
    console.log('Nothing is waiting.')
    return
  }

  if (dryRun) {
    let notInList = 0
    for (const row of rows) {
      const listed = env.AUTO_STAMP_TYPES.has(row.documentCode)
      if (!listed) notInList += 1
      console.log(
        `#${row.documentId}  ${row.documentName}` + (listed ? '' : '  not in the auto-stamp list'),
      )
    }
    console.log(
      `\n${rows.length - notInList} would be decided against a template, ` +
        `${notInList} recorded as not in the auto-stamp list.` +
        '\nDry run: nothing was decided, recorded or changed.',
    )
    return
  }

  const fallback = await resolveFallback(flags.get('as'))
  const counts = new Map<string, number>()
  let skipped = 0

  await runBacklog(rows, {
    fallback,
    context: { ipAddress: null, userAgent: 'auto-stamp backlog' },
    // An account that has been deactivated or removed is not somebody to
    // sign in the name of; the fallback is.
    resolveUploader: async (userId) => {
      const user = await userRepository.findById(userId)
      return user && user.isActive ? userRepository.toAuthUser(user) : null
    },
    onEach: ({ documentId, documentName, result, usedFallback }) => {
      if (!result) {
        skipped += 1
        console.log(`#${documentId}  ${documentName}  (left as it was)`)
        return
      }
      const label = STAMP_OUTCOME_LABEL[result.decision.outcome]
      counts.set(label, (counts.get(label) ?? 0) + 1)
      console.log(
        `#${documentId}  ${documentName}  ${label}` +
          (result.stamped > 0 ? `  stamped ${result.stamped}` : '') +
          (usedFallback ? `  (uploader gone; decided as ${fallback.username})` : '') +
          `\n    ${result.decision.summary}`,
      )
    },
  })

  console.log(`\n${rows.length - skipped} decided, ${skipped} left as they were`)
  for (const [label, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${label}`)
  }
}

/** 'employee signature p1, photograph p1' */
function boxList(boxes: readonly StampBoxDecision[]): string {
  return boxes
    .map((box) => `${SIGNER_ROLE_LABEL[box.signerRole].toLowerCase()} p${box.pageNumber}`)
    .join(', ')
}

/** One line per document: what would be, or was, added, kept and left. */
function describeRedecide(outcome: RedecideOutcome): string {
  const head = `#${outcome.documentId}  ${outcome.documentName}`
  if (outcome.kind === 'left') return `${head}  left alone: ${outcome.detail}`

  const decision = outcome.kind === 'preview' ? outcome.decision : outcome.result.decision
  const add = decision.boxes.filter((box) => box.action === 'stamp')
  const keep = decision.boxes.filter((box) => box.action === 'keep')
  const leave = decision.boxes.filter((box) => box.action === 'skip')
  const parts = [
    add.length > 0 ? `${outcome.kind === 'preview' ? 'would add' : 'added'}: ${boxList(add)}` : '',
    keep.length > 0
      ? `keep: ${keep.map((box) => `${boxList([box])} (${box.reason})`).join(', ')}`
      : '',
    leave.length > 0
      ? `leave: ${leave.map((box) => `${boxList([box])} - ${box.reason}`).join('; ')}`
      : '',
  ].filter((part) => part.length > 0)
  const status =
    outcome.kind === 'decided'
      ? `  -> ${outcome.result.status}` + (outcome.result.stamped === 0 ? ' (nothing painted)' : '')
      : ''
  return `${head}  ${parts.join('; ') || STAMP_OUTCOME_LABEL[decision.outcome]}${status}`
}

async function redecide(flags: Map<string, string>): Promise<void> {
  const dryRun = flags.get('dry-run') === 'true'
  const limit = readLimit(flags)
  const documentCode = flags.get('type')
  if (!documentCode || documentCode === 'true') {
    throw new Error('--redecide needs --type <document code>, such as --type ESIC_FORM')
  }
  if (!env.AUTO_STAMP_TYPES.has(documentCode)) {
    throw new Error(
      `${documentCode} is not in AUTO_STAMP_TYPES (${[...env.AUTO_STAMP_TYPES].join(',') || 'empty'}); ` +
        'nothing of that type is stamped on upload, so nothing is decided again either',
    )
  }

  const rows = await employeeDocumentRepository.listWaitingOfType(documentCode, limit)
  console.log(
    `Stamping on upload - deciding again: ${rows.length} ${documentCode} document(s) waiting` +
      (rows.length === limit ? ` (stopped at ${limit})` : '') +
      `\nAUTO_STAMP=${env.AUTO_STAMP}: ` +
      (env.AUTO_STAMP === 'stamp'
        ? 'what is missing WILL be added; what is on a document already is kept.'
        : 'decisions are recorded and nothing is stamped.') +
      (dryRun ? '\nDry run: read and decided, nothing written.' : '') +
      '\n',
  )
  if (rows.length === 0) {
    console.log('Nothing is waiting.')
    return
  }

  const fallback = await resolveFallback(flags.get('as'))
  const counts = new Map<string, number>()
  const count = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1)

  await redecideType(rows, {
    dryRun,
    fallback,
    context: { ipAddress: null, userAgent: dryRun ? 'redecide dry run' : 'redecide command' },
    resolveUploader: async (userId) => {
      const user = await userRepository.findById(userId)
      return user && user.isActive ? userRepository.toAuthUser(user) : null
    },
    onEach: (outcome) => {
      console.log(describeRedecide(outcome))
      if (outcome.kind === 'left') count(`left alone: ${outcome.reason}`)
      else if (outcome.kind === 'preview') {
        count(
          outcome.decision.toStamp.length > 0
            ? 'would be added to'
            : STAMP_OUTCOME_LABEL[outcome.decision.outcome],
        )
      } else count(STAMP_OUTCOME_LABEL[outcome.result.decision.outcome])
    },
  })

  console.log(`\n${rows.length} looked at${dryRun ? ', nothing changed' : ''}`)
  for (const [label, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${label}`)
  }
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  if (flags.has('backlog')) await backlog(flags)
  else if (flags.has('redecide')) await redecide(flags)
  else await report(flags)
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
