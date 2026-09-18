import {
  findVariant,
  toVariant,
  variantKey,
  variantLabel,
  type DocumentTypePlacement,
  type TemplateVariant,
} from '@asps-dms/shared'
import type { StampCheckCandidate } from '../repositories/employeeDocument.repository.js'
import {
  assessBoxes,
  settingsFromEnv,
  type BoxAssessment,
  type OccupancySettings,
} from './boxOccupancy.service.js'
import { openPdf } from './pdfRaster.service.js'
import * as storage from './storage.service.js'

/**
 * The stamp-check report: what the occupancy rule says about real documents.
 *
 * For every document whose type has a template, the template's boxes are
 * assessed against the ORIGINAL file exactly as savePlacements would assess
 * them, and the verdicts and numbers are collected for printing. Nothing is
 * stamped, saved or recorded; the files are read and the database is only
 * read. The point is to see, on the office's own forms, where the thresholds
 * in `STAMP_*` fall before they are relied on.
 *
 * Nothing here knows which employee a document belongs to. The candidate
 * carries no employee field, and the report prints none, so the output can
 * be shared without becoming a list of who has not signed what.
 */

export const DEFAULT_COMPARE_CUTOFFS: readonly number[] = [128, 160, 200]

export type StampCheckOutcome =
  /** Boxes assessed. */
  | 'checked'
  /** The type has templates, but none for this document's page count and size. */
  | 'noVariant'
  /** More than one template claims the document; it would not be stamped from either. */
  | 'ambiguousVariant'
  /** Not a PDF: templates are for the office's generated forms, which are. */
  | 'notPdf'
  /** The file is recorded but cannot be read or opened. */
  | 'unreadable'

export interface StampCheckResult {
  documentId: number
  documentCode: string
  documentName: string
  signatureStatus: string
  hasProcessedFile: boolean
  outcome: StampCheckOutcome
  /** What the document is, when it could be measured. */
  measured: TemplateVariant | null
  /** The template variant it matched, when one did. */
  variant: TemplateVariant | null
  boxes: BoxAssessment[]
  detail?: string
}

/** The page count and first-page size of a PDF, as the template editor measures them. */
export async function measurePdf(source: Buffer): Promise<TemplateVariant> {
  const pdf = await openPdf(source)
  try {
    const first = await pdf.getPage(1)
    // The page's own box, unrotated: the same thing the editor keys the
    // variant on, so a form matches its template whichever way it is shown.
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = first.view
    return toVariant(pdf.numPages, x1 - x0, y1 - y0)
  } finally {
    await pdf.destroy()
  }
}

/** The variants a type's template rows describe, each once. */
export function variantsOf(rows: readonly DocumentTypePlacement[]): TemplateVariant[] {
  const seen = new Map<string, TemplateVariant>()
  for (const row of rows) seen.set(variantKey(row.variant), row.variant)
  return Array.from(seen.values())
}

/**
 * Assesses one document against its type's template.
 *
 * `rows` are every box of every variant of the type; the document's own
 * variant picks which apply. The settings default to the environment's, with
 * the comparison cut-offs added so the report can show them.
 */
export async function checkDocument(
  candidate: StampCheckCandidate,
  rows: readonly DocumentTypePlacement[],
  options: {
    settings?: OccupancySettings
    compareCutoffs?: readonly number[]
    readFile?: (relativePath: string) => Promise<Buffer>
  } = {},
): Promise<StampCheckResult> {
  const base: Omit<StampCheckResult, 'outcome' | 'measured' | 'variant' | 'boxes'> = {
    documentId: candidate.documentId,
    documentCode: candidate.documentCode,
    documentName: candidate.documentName,
    signatureStatus: candidate.signatureStatus,
    hasProcessedFile: candidate.hasProcessedFile,
  }
  const settings: OccupancySettings = {
    ...(options.settings ?? settingsFromEnv()),
    compareCutoffs: options.compareCutoffs ?? DEFAULT_COMPARE_CUTOFFS,
  }

  if ((candidate.mimeType ?? 'application/pdf') !== 'application/pdf') {
    return { ...base, outcome: 'notPdf', measured: null, variant: null, boxes: [] }
  }

  let source: Buffer
  let measured: TemplateVariant
  try {
    source = await (options.readFile ?? storage.readStoredFile)(candidate.originalFilePath)
    measured = await measurePdf(source)
  } catch (error) {
    return {
      ...base,
      outcome: 'unreadable',
      measured: null,
      variant: null,
      boxes: [],
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const variants = variantsOf(rows)
  const matching = variants.filter((variant) => findVariant([variant], measured) !== null)
  if (matching.length !== 1) {
    return {
      ...base,
      outcome: matching.length === 0 ? 'noVariant' : 'ambiguousVariant',
      measured,
      variant: null,
      boxes: [],
      detail:
        matching.length === 0
          ? `templates: ${variants.map(variantLabel).join(', ') || 'none'}`
          : `matches ${matching.map(variantLabel).join(' and ')}`,
    }
  }
  const variant = matching[0] as TemplateVariant

  const boxes = rows
    .filter((row) => variantKey(row.variant) === variantKey(variant))
    .map((row, index) => ({
      label: String(index),
      signerRole: row.signerRole,
      pageNumber: row.pageNumber,
      rect: { x: row.x, y: row.y, width: row.width, height: row.height },
    }))

  const assessed = await assessBoxes(source, 'application/pdf', boxes, settings)
  return { ...base, outcome: 'checked', measured, variant, boxes: assessed }
}

/* -------------------------------------------------------------------------- */
/* Printing                                                                    */
/* -------------------------------------------------------------------------- */

const OUTCOME_TEXT: Record<StampCheckOutcome, string> = {
  checked: 'checked',
  noVariant: 'no template for this form',
  ambiguousVariant: 'more than one template matches',
  notPdf: 'not a PDF',
  unreadable: 'unreadable',
}

function pct(value: number, places = 2): string {
  return `${value.toFixed(places)}%`
}

/** One document's lines. Document id, type, status and numbers; no employee. */
export function formatResult(result: StampCheckResult): string[] {
  const status = `${result.signatureStatus}${result.hasProcessedFile ? ', has signed copy' : ''}`
  const head = `#${result.documentId}  ${result.documentName} [${result.documentCode}]  (${status})`
  if (result.outcome !== 'checked') {
    const what = result.measured ? `  is ${variantLabel(result.measured)}` : ''
    return [`${head}${what}`, `    ${OUTCOME_TEXT[result.outcome]}${result.detail ? `: ${result.detail}` : ''}`]
  }

  const lines = [`${head}  ${variantLabel(result.variant as TemplateVariant)}`]
  for (const box of result.boxes) {
    const where = `${(box.signerRole ?? '').padEnd(10)} p${box.pageNumber}`
    const verdict = `${box.verdict.padEnd(9)} by ${box.decidedBy.padEnd(5)} ${box.pageKind.padEnd(7)}`
    const overlap =
      box.overlap.images > 0
        ? `images ${box.overlap.images}, best ${pct(box.overlap.coverage * 100, 0)}`
        : 'no image'
    let ink = ''
    if (box.ink) {
      ink = `  ink ${pct(box.ink.percent)} (bg ${box.ink.background}, cut ${box.ink.cutoff})`
      if (box.ink.atCutoff && box.ink.atCutoff.length > 0) {
        ink += `  fixed ${box.ink.atCutoff.map((at) => `@${at.cutoff} ${pct(at.percent)}`).join(' ')}`
      }
    }
    lines.push(`    ${where}  ${verdict}  ${overlap}${ink}`)
  }
  return lines
}

export interface StampCheckSummary {
  /** Per document type: verdict counts over checked boxes. */
  byType: { documentName: string; documentCode: string; empty: number; occupied: number; uncertain: number; documents: number }[]
  byOutcome: Record<StampCheckOutcome, number>
  /** Signed (has a processed copy) yet a box came out empty: the check missed our own stamp. */
  signedButEmpty: number[]
  /** Not signed yet a box came out occupied: something was there, or the threshold is low. */
  unsignedButOccupied: number[]
  uncertain: number[]
}

/** What the run adds up to, and which documents disagree with their own status. */
export function summarise(results: readonly StampCheckResult[]): StampCheckSummary {
  const byType = new Map<string, StampCheckSummary['byType'][number]>()
  const byOutcome: Record<StampCheckOutcome, number> = {
    checked: 0,
    noVariant: 0,
    ambiguousVariant: 0,
    notPdf: 0,
    unreadable: 0,
  }
  const signedButEmpty: number[] = []
  const unsignedButOccupied: number[] = []
  const uncertain: number[] = []

  for (const result of results) {
    byOutcome[result.outcome] += 1
    if (result.outcome !== 'checked') continue

    const row = byType.get(result.documentCode) ?? {
      documentName: result.documentName,
      documentCode: result.documentCode,
      empty: 0,
      occupied: 0,
      uncertain: 0,
      documents: 0,
    }
    row.documents += 1
    for (const box of result.boxes) row[box.verdict] += 1
    byType.set(result.documentCode, row)

    const verdicts = new Set(result.boxes.map((box) => box.verdict))
    if (result.hasProcessedFile && verdicts.has('empty')) signedButEmpty.push(result.documentId)
    if (!result.hasProcessedFile && verdicts.has('occupied')) {
      unsignedButOccupied.push(result.documentId)
    }
    if (verdicts.has('uncertain')) uncertain.push(result.documentId)
  }

  return {
    byType: Array.from(byType.values()),
    byOutcome,
    signedButEmpty,
    unsignedButOccupied,
    uncertain,
  }
}

export function formatSummary(summary: StampCheckSummary, settings: OccupancySettings): string[] {
  const lines: string[] = ['']
  lines.push(
    `  Settings: full page >= ${settings.fullPageMin}, overlap >= ${settings.overlapMin},` +
      ` ink empty <= ${pct(settings.inkEmptyMax * 100, 1)}, occupied >= ${pct(settings.inkOccupiedMin * 100, 1)},` +
      ` margin ${settings.inkMargin}, ceiling ${settings.inkCutoffCeiling}`,
  )
  lines.push('')
  lines.push(`  ${'type'.padEnd(28)} ${'docs'.padStart(6)} ${'empty'.padStart(7)} ${'occupied'.padStart(9)} ${'uncertain'.padStart(10)}`)
  for (const row of summary.byType) {
    lines.push(
      `  ${row.documentName.slice(0, 28).padEnd(28)} ${String(row.documents).padStart(6)}` +
        ` ${String(row.empty).padStart(7)} ${String(row.occupied).padStart(9)} ${String(row.uncertain).padStart(10)}`,
    )
  }
  lines.push('')
  for (const [outcome, count] of Object.entries(summary.byOutcome) as [StampCheckOutcome, number][]) {
    if (count > 0) lines.push(`  ${OUTCOME_TEXT[outcome].padEnd(32)} ${String(count).padStart(6)}`)
  }

  const list = (ids: number[]) => ids.map((id) => `#${id}`).join(' ')
  if (summary.signedButEmpty.length > 0) {
    lines.push('')
    lines.push(`  Signed copy exists but a box reads EMPTY (${summary.signedButEmpty.length}):`)
    lines.push(`    ${list(summary.signedButEmpty)}`)
  }
  if (summary.unsignedButOccupied.length > 0) {
    lines.push('')
    lines.push(`  No signed copy but a box reads OCCUPIED (${summary.unsignedButOccupied.length}):`)
    lines.push(`    ${list(summary.unsignedButOccupied)}`)
  }
  if (summary.uncertain.length > 0) {
    lines.push('')
    lines.push(`  A box the rule could not decide (${summary.uncertain.length}):`)
    lines.push(`    ${list(summary.uncertain)}`)
  }
  return lines
}
