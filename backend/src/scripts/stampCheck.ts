/**
 * What the 'is the box already signed?' rule says about real documents.
 *
 *   npm run stamp-check
 *   npm run stamp-check -- --type PF_FORM
 *   npm run stamp-check -- --document 1234
 *   npm run stamp-check -- --limit 50 --cutoffs 128,160,200
 *   npm run stamp-check -- --shapes
 *   npm run stamp-check -- --list
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
 * --shapes answers a different question and changes nothing either: for
 * every active type, the SHAPES its stored documents come in - page count,
 * way up, proportion - grouped the way a template matches them, with how
 * many documents are each shape and which shapes already have a template.
 * That is how many templates a type needs, and it is what the editor shows
 * beside a sample.
 *
 * --list is the Templates screen on the console: for every type, the
 * templates saved - shape, boxes, who set it and when - and, against the
 * shapes the documents actually come in, which shapes have no template and
 * how many documents that leaves uncovered. For checking from the server
 * without opening the app. Read-only.
 *
 * Flags:
 *   --shapes             the shapes of every type's documents, and nothing else
 *   --list               the templates saved, and what they cover
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
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import { sameShape, shapeOf, variantLabel } from '@asps-dms/shared'
import { shapesForType } from '../services/templateShapes.service.js'
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

/** Every type's shapes, one block each. No employee is named. */
async function printShapes(documentCode: string | undefined): Promise<void> {
  const types = (await documentTypeRepository.listActive()).filter(
    (type) => documentCode === undefined || type.documentCode === documentCode,
  )
  let templatesNeeded = 0
  for (const type of types) {
    const shapes = await shapesForType(type.documentTypeId)
    const groups = shapes.groups.length
    templatesNeeded += groups
    console.log(
      `${type.documentName}: ${shapes.measured} PDF(s) measured` +
        (shapes.unmeasured ? `, ${shapes.unmeasured} not measurable` : '') +
        ` -> ${groups} shape(s)`,
    )
    for (const group of shapes.groups) {
      console.log(
        `    ${group.label.padEnd(24)} ${String(group.documents).padStart(4)} docs ` +
          `${String(group.percent).padStart(3)}%  ${group.hasTemplate ? 'template saved' : 'NO TEMPLATE'}` +
          `
      sizes: ${group.sizes.slice(0, 6).join(', ')}${group.sizes.length > 6 ? ` +${group.sizes.length - 6} more` : ''}`,
      )
    }
  }
  console.log(`
${templatesNeeded} template(s) would cover every shape seen, across ${types.length} type(s).`)
}

function when(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`
}

/**
 * Every type's saved templates and what they cover. No employee is named -
 * the summary carries the sample's employee code for the screen, and it is
 * left out here on purpose.
 */
async function printList(documentCode: string | undefined): Promise<void> {
  const summaries = (await documentTypePlacementRepository.summaries()).filter(
    (summary) => documentCode === undefined || summary.documentCode === documentCode,
  )
  let uncoveredDocuments = 0
  let uncoveredShapes = 0

  for (const summary of summaries) {
    const shapes = await shapesForType(summary.documentTypeId)
    const templates = summary.variants
    console.log(
      `${summary.documentName}: ${templates.length} template(s), ` +
        `${shapes.measured} PDF(s) in ${shapes.groups.length} shape(s)`,
    )

    for (const template of templates) {
      const roles = Object.entries(template.roles)
        .map(([role, count]) => (count === 1 ? role : `${role} x${count}`))
        .join(', ')
      const group = shapes.groups.find((g) =>
        sameShape(shapeOf(g.variant), shapeOf(template.variant)),
      )
      const covers = group
        ? `covers ${group.documents} doc(s), ${group.percent}%`
        : 'covers NO stored document'
      console.log(
        `    ${variantLabel(template.variant).padEnd(24)} ${template.boxes} box(es): ${roles}` +
          (template.pageRotation ? `, rotated ${template.pageRotation}` : '') +
          `  set by ${template.setByName ?? 'unknown'} ${when(template.setAt)}  ${covers}`,
      )
    }

    for (const group of shapes.groups.filter((g) => !g.hasTemplate)) {
      uncoveredShapes += 1
      uncoveredDocuments += group.documents
      console.log(
        `    ${group.label.padEnd(24)} NO TEMPLATE  ${group.documents} doc(s), ${group.percent}%` +
          `  sizes: ${group.sizes.slice(0, 4).join(', ')}${group.sizes.length > 4 ? ' ...' : ''}`,
      )
    }
  }

  console.log(
    `
${uncoveredShapes} shape(s) without a template, ${uncoveredDocuments} document(s) not covered.`,
  )
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2))
  const documentCode = flags.get('type')
  if (flags.has('shapes')) {
    await printShapes(documentCode)
    return
  }
  if (flags.has('list')) {
    await printList(documentCode)
    return
  }
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
  const rowsByType = new Map<
    number,
    Awaited<ReturnType<typeof documentTypePlacementRepository.listForType>>
  >()
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
