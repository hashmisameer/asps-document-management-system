/**
 * What the 'is the box already signed?' rule says about real documents.
 *
 *   npm run stamp-check
 *   npm run stamp-check -- --type PF_FORM
 *   npm run stamp-check -- --document 1234
 *   npm run stamp-check -- --limit 50 --cutoffs 128,160,200
 *
 * For every document whose type has a template, the template's boxes are
 * assessed against the ORIGINAL file exactly as a save would assess them, and
 * the verdicts are printed with the numbers behind them, so the STAMP_*
 * settings can be judged on the office's own forms before they are relied on.
 *
 * Read-only. Nothing is stamped, saved or recorded; the files are read and
 * the database is only read.
 *
 * The report names no employee - not a name, not a code, not an id. Document
 * ids, types, statuses and measurements only. It is meant to be pasted into a
 * message, and a list of who has not signed what is not.
 *
 * Flags:
 *   --type <code>        one document type, by its code
 *   --document <id>      one document
 *   --limit <n>          stop after n documents (default 500)
 *   --cutoffs <a,b,c>    fixed ink cut-offs to show alongside (default 128,160,200)
 */
import { closePool } from '../database/pool.js'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import { settingsFromEnv } from '../services/boxOccupancy.service.js'
import {
  DEFAULT_COMPARE_CUTOFFS,
  checkDocument,
  formatResult,
  formatSummary,
  summarise,
  type StampCheckResult,
} from '../services/stampCheck.service.js'
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

function readCutoffs(text: string | undefined): readonly number[] {
  if (!text) return DEFAULT_COMPARE_CUTOFFS
  const values = text.split(',').map((part) => Number(part.trim()))
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 255)) {
    throw new Error('--cutoffs must be whole numbers between 1 and 255, separated by commas')
  }
  return values
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const documentCode = flags.get('type')
  const documentId = flags.has('document') ? Number(flags.get('document')) : undefined
  if (documentId !== undefined && (!Number.isInteger(documentId) || documentId <= 0)) {
    throw new Error('--document must be a positive whole number')
  }
  const limit = flags.has('limit') ? Number(flags.get('limit')) : 500
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive number')
  const compareCutoffs = readCutoffs(flags.get('cutoffs'))

  const candidates = await employeeDocumentRepository.listForStampCheck({
    documentCode,
    documentId,
    limit,
  })

  console.log(`\nStamp check  (read-only; no employee is named)`)
  console.log(`  ${candidates.length} document(s) with a file whose type has a template\n`)
  if (candidates.length === 0) {
    if (documentId !== undefined) {
      console.log('  That document has no file, or its type has no template.')
    } else if (documentCode) {
      console.log(`  No document of type ${documentCode} has a file, or the type has no template.`)
    } else {
      console.log('  Save a template first (Settings > Templates), then run this again.')
    }
    return
  }

  // Every type's rows once, not once per document.
  const rowsByType = new Map<number, Awaited<ReturnType<typeof documentTypePlacementRepository.listForType>>>()
  const rowsFor = async (documentTypeId: number) => {
    const cached = rowsByType.get(documentTypeId)
    if (cached) return cached
    const rows = await documentTypePlacementRepository.listForType(documentTypeId)
    rowsByType.set(documentTypeId, rows)
    return rows
  }

  const settings = settingsFromEnv()
  const results: StampCheckResult[] = []
  for (const candidate of candidates) {
    const result = await checkDocument(candidate, await rowsFor(candidate.documentTypeId), {
      settings,
      compareCutoffs,
    })
    results.push(result)
    for (const line of formatResult(result)) console.log(line)
  }

  for (const line of formatSummary(summarise(results), { ...settings, compareCutoffs })) {
    console.log(line)
  }
  console.log('\nNothing was changed.')
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
