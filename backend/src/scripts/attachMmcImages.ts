/**
 * Attaches the photographs and signatures MMC already holds to the employees
 * already in the database.
 *
 *   npm run attach-mmc-images -- --dry-run
 *   npm run attach-mmc-images
 *
 * The dry run reads every file it would read and reports what it WOULD do,
 * per employee and in total, and writes nothing. Run it first.
 *
 * Flags:
 *   --dry-run            report only; nothing is written
 *   --limit <n>          stop after n employees, for a cautious first run
 *   --code <code>        one employee only, by eight-digit code
 *   --as <username>      whose name the attachments are recorded in. Defaults
 *                        to the first active administrator
 *   --replace            attach even where the employee already has one. OFF
 *                        by default: what was uploaded by hand is left alone
 *   --include-archived   archived employees as well; active only by default
 *
 * The MMC folders are read and never written. Every conversion - a progressive
 * JPEG made baseline, a photograph over the limit shrunk, a signature's paper
 * made transparent - happens to the copy on its way into the DMS store.
 */
import { ROLES, type AuthUser } from '@asps-dms/shared'
import { closePool } from '../database/pool.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import {
  attachMissing,
  configuredDirectories,
  folderReachable,
  isConfigured,
  type MmcAttachResult,
  type MmcImageKind,
  type MmcOutcome,
} from '../services/mmcImages.service.js'
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

async function resolveActor(username: string | undefined): Promise<AuthUser> {
  if (username) {
    const user = await userRepository.findByUsername(username)
    if (!user) throw new Error(`There is no user named '${username}'`)
    return userRepository.toAuthUser(user)
  }
  const admin = await userRepository.findFirstByRole(ROLES.ADMIN)
  if (!admin) {
    throw new Error(
      'No administrator account exists to attach as.\n' +
        '  Name a user:  npm run attach-mmc-images -- --as <username>',
    )
  }
  return userRepository.toAuthUser(admin)
}

const OUTCOME_TEXT: Record<MmcOutcome, string> = {
  attached: 'attached',
  wouldAttach: 'will attach',
  alreadyHad: 'already has one',
  noFile: 'no file found',
  codeNotUsable: 'code not 8 digits',
  unreadable: 'unreadable',
  off: 'off',
}

const TALLY_ROWS: readonly { key: MmcOutcome; label: string }[] = [
  { key: 'alreadyHad', label: 'already had' },
  { key: 'attached', label: 'attached' },
  { key: 'wouldAttach', label: 'will attach' },
  { key: 'noFile', label: 'no file found' },
  { key: 'codeNotUsable', label: 'code not usable' },
  { key: 'unreadable', label: 'unreadable' },
]

type Tally = Record<MmcImageKind, Record<MmcOutcome, number>>

function emptyTally(): Tally {
  const zero = (): Record<MmcOutcome, number> => ({
    attached: 0,
    wouldAttach: 0,
    alreadyHad: 0,
    noFile: 0,
    codeNotUsable: 0,
    unreadable: 0,
    off: 0,
  })
  return { photo: zero(), signature: zero() }
}

function describeLine(
  employee: { employeeCode: string; employeeName: string },
  result: MmcAttachResult,
): string {
  const cell = (kind: MmcImageKind): string => {
    const text = OUTCOME_TEXT[result[kind]]
    const why = result.detail?.[kind]
    return why ? `${text} (${why})` : text
  }
  return (
    `  ${employee.employeeCode.padEnd(10)} ${employee.employeeName.slice(0, 24).padEnd(24)}` +
    ` photo: ${cell('photo').padEnd(22)} signature: ${cell('signature')}`
  )
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const dryRun = flags.get('dry-run') === 'true'
  const replace = flags.get('replace') === 'true'
  const includeArchived = flags.get('include-archived') === 'true'
  const onlyCode = flags.get('code')
  const limit = flags.has('limit') ? Number(flags.get('limit')) : Number.POSITIVE_INFINITY
  if (Number.isNaN(limit) || limit <= 0) throw new Error('--limit must be a positive number')

  const dirs = configuredDirectories()
  if (!isConfigured(dirs)) {
    throw new Error(
      'MMC_PHOTO_DIR and MMC_SIGNATURE_DIR are not set in backend/.env.\n' +
        '  Set one or both to the folders MMC writes, e.g.\n' +
        '    MMC_PHOTO_DIR=G:\\MMC SOFTWARE\\Debug\\Image\n' +
        '    MMC_SIGNATURE_DIR=G:\\MMC SOFTWARE\\Debug\\Signature',
    )
  }

  console.log(`\nAttaching MMC images${dryRun ? '  (dry run - nothing written)' : ''}`)
  for (const kind of ['photo', 'signature'] as const) {
    const dir = dirs[kind]
    if (!dir) {
      console.log(`  ${kind.padEnd(10)} : not configured`)
      continue
    }
    if (!(await folderReachable(dir))) {
      throw new Error(`The ${kind} folder cannot be reached: ${dir}`)
    }
    const count = (await import('node:fs/promises')).readdir(dir).then((names) =>
      names.filter((name) => /^\d{8}\.jpe?g$/i.test(name)).length,
    )
    console.log(`  ${kind.padEnd(10)} : ${dir}  (${await count} files named by code)`)
  }
  if (replace) console.log('  --replace: existing photographs and signatures WILL be replaced')
  console.log('')

  const actor = await resolveActor(flags.get('as'))
  const context = { ipAddress: null, userAgent: 'attach-mmc-images' }

  const employees = await employeeRepository.listAll({
    sortBy: 'employeeCode',
    sortDir: 'asc',
    status: 'all',
    includeArchived,
    archivedOnly: false,
    missingIdCard: false,
    withoutSignature: false,
    leftThisYear: false,
  })
  const chosen = employees
    .filter((employee) => !onlyCode || employee.employeeCode === onlyCode)
    .slice(0, Number.isFinite(limit) ? limit : undefined)

  if (onlyCode && chosen.length === 0) throw new Error(`There is no employee with code ${onlyCode}`)

  const tally = emptyTally()
  let progressivePhotos = 0
  let progressiveSignatures = 0

  for (const employee of chosen) {
    const result = await attachMissing(employee, actor, context, { dryRun, replace, dirs })
    tally.photo[result.photo] += 1
    tally.signature[result.signature] += 1
    if (result.progressive?.photo) progressivePhotos += 1
    if (result.progressive?.signature) progressiveSignatures += 1
    console.log(describeLine(employee, result))
  }

  console.log('')
  console.log(`  ${''.padEnd(20)} ${'photos'.padStart(8)} ${'signatures'.padStart(12)}`)
  for (const row of TALLY_ROWS) {
    const photos = tally.photo[row.key]
    const signatures = tally.signature[row.key]
    if (photos === 0 && signatures === 0) continue
    console.log(
      `  ${row.label.padEnd(20)} ${String(photos).padStart(8)} ${String(signatures).padStart(12)}`,
    )
  }
  console.log(`  ${'-'.repeat(42)}`)
  console.log(
    `  ${'employees'.padEnd(20)} ${String(chosen.length).padStart(8)} ${String(chosen.length).padStart(12)}`,
  )
  console.log(
    `\n  Progressive JPEGs in the source (re-encoded on copy): ${progressivePhotos} photo(s), ${progressiveSignatures} signature(s)`,
  )

  if (dryRun) {
    console.log('\nDry run: nothing was written. Run again without --dry-run to attach.')
  } else {
    console.log(
      `\nAttached ${tally.photo.attached} photograph(s) and ${tally.signature.attached} signature(s).` +
        ' Nothing in the MMC folders was changed.',
    )
  }
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
