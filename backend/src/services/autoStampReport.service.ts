import {
  SIGNER_ROLE_LABEL,
  STAMP_OUTCOME_LABEL,
  STAMP_OUTCOMES,
  type SignatureStatus,
  type StampBoxDecision,
  type StampOutcome,
} from '@asps-dms/shared'
import type { StampDecisionReportRow } from '../repositories/stampDecision.repository.js'
import type { RedecideOutcome } from './autoStampRun.service.js'

/**
 * The trial report: what stamping on upload decided, printed for reading.
 *
 * Run in report mode for a few days, this is how the office sees what WOULD
 * have been stamped before anything is. Pure: rows in, lines out, so the
 * wording and the counting are tested against plain values.
 *
 * THE REPORT NAMES NO EMPLOYEE - not a name, not a code, not an id. Document
 * ids, types, outcomes and reasons only. It is meant to be pasted into a
 * message, and a list of who has not signed what is not.
 */

/**
 * '7d', '24h', '30m', or a date 'YYYY-MM-DD', as a moment. Null when it is
 * none of those, so the caller can say so rather than reporting since epoch.
 */
export function parseSince(text: string, now: Date = new Date()): Date | null {
  const relative = /^(\d+)([dhm])$/.exec(text.trim())
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]
    const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000
    return new Date(now.getTime() - amount * ms)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
    const at = new Date(`${text.trim()}T00:00:00`)
    return Number.isNaN(at.getTime()) ? null : at
  }
  return null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** '18/09/2026 09:41', the office's own clock. */
function when(iso: string): string {
  const at = new Date(iso)
  return (
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/** One decision's lines: the document, what was decided, and each box. */
export function formatDecision(row: StampDecisionReportRow): string[] {
  const header =
    `#${row.documentId}  ${row.documentName}  ${when(row.decidedAt)}  ` +
    `${row.mode.toLowerCase()}  ${STAMP_OUTCOME_LABEL[row.outcome]}` +
    (row.variantKey ? `  ${row.variantKey}` : '')
  const lines = [header, `    ${row.summary}`]
  for (const box of row.boxes) {
    const found = box.found ? `, found ${box.found}` : ''
    lines.push(
      `    - ${box.signerRole.toLowerCase()} p${box.pageNumber}: ${box.action}${found}` +
        (box.reason ? ` - ${box.reason}` : ''),
    )
  }
  return lines
}

export interface ReportSummary {
  decisions: number
  /**
   * Documents of a type the server is not set to stamp. Counted apart, and
   * never among the reasons boxes were left alone: they were left for HR on
   * purpose, and a report that listed them as failures would be wrong.
   */
  notInList: number
  byOutcome: Partial<Record<StampOutcome, number>>
  /** Boxes that were, or in report mode would have been, stamped. */
  boxesStamped: number
  boxesLeftAlone: number
  /** Boxes MMC fills that arrived filled: done, nothing painted. */
  boxesFilled: number
  /** The reasons boxes were left alone, most common first. */
  reasons: { reason: string; count: number }[]
  /** What was measured in the boxes taken as filled, most common first. */
  filledBecause: { reason: string; count: number }[]
  /**
   * Boxes the template expects empty that were occupied - most likely a box
   * drawn over something printed on the form. Each one is listed: there
   * should be few, and every one is a box somebody has to go and move.
   */
  checkTemplate: { documentId: number; documentName: string; box: string; reason: string }[]
  /**
   * Documents finished with at least one box taken as filled, nothing of
   * ours in it. The ones to spot-check: a box read wrongly as filled is a
   * document finished with that box empty.
   */
  finishedWithFilled: number[]
  /** How many decisions were only ever recorded, versus acted on. */
  reportMode: number
  stampMode: number
}

/** The whole run at a glance, for the top of the report. */
export function summarise(rows: readonly StampDecisionReportRow[]): ReportSummary {
  const byOutcome: Partial<Record<StampOutcome, number>> = {}
  const reasonCounts = new Map<string, number>()
  let boxesStamped = 0
  let boxesLeftAlone = 0
  let boxesFilled = 0
  const filledCounts = new Map<string, number>()
  const checkTemplate: ReportSummary['checkTemplate'] = []
  const finishedWithFilled: number[] = []
  let reportMode = 0
  let stampMode = 0
  let notInList = 0

  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1
    if (row.outcome === STAMP_OUTCOMES.NOT_IN_LIST) {
      notInList += 1
      continue
    }
    boxesStamped += row.stampedCount
    boxesLeftAlone += row.skippedCount
    if (row.mode === 'Report') reportMode += 1
    else stampMode += 1
    for (const box of row.boxes) {
      if (box.action === 'skip' && box.reason) {
        reasonCounts.set(box.reason, (reasonCounts.get(box.reason) ?? 0) + 1)
      }
      if (box.action === 'filled') {
        boxesFilled += 1
        if (box.reason) filledCounts.set(box.reason, (filledCounts.get(box.reason) ?? 0) + 1)
      }
      if (box.checkTemplate) {
        checkTemplate.push({
          documentId: row.documentId,
          documentName: row.documentName,
          box: boxName(box),
          reason: box.reason ?? 'no reason recorded',
        })
      }
    }
    if (
      row.outcome === STAMP_OUTCOMES.STAMPED &&
      row.boxes.some((box) => box.action === 'filled')
    ) {
      finishedWithFilled.push(row.documentId)
    }
    // A document-level refusal has no boxes; its one reason is the summary.
    if (row.boxes.length === 0 && row.outcome !== STAMP_OUTCOMES.STAMPED) {
      const reason = STAMP_OUTCOME_LABEL[row.outcome]
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }
  }

  return {
    decisions: rows.length,
    notInList,
    byOutcome,
    boxesStamped,
    boxesLeftAlone,
    boxesFilled,
    reasons: mostCommonFirst(reasonCounts),
    filledBecause: mostCommonFirst(filledCounts),
    checkTemplate,
    finishedWithFilled,
    reportMode,
    stampMode,
  }
}

function mostCommonFirst(counts: ReadonlyMap<string, number>): { reason: string; count: number }[] {
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

/** 'hr signature p2' */
function boxName(box: Pick<StampBoxDecision, 'signerRole' | 'pageNumber'>): string {
  return `${SIGNER_ROLE_LABEL[box.signerRole].toLowerCase()} p${box.pageNumber}`
}

/** How many document ids a list prints before it says how many more. */
const IDS_SHOWN = 20

export function formatSummary(summary: ReportSummary): string[] {
  const lines = [
    `${summary.decisions} decision(s): ${summary.reportMode} recorded only, ${summary.stampMode} stamped` +
      (summary.notInList > 0
        ? `, ${summary.notInList} not in the auto-stamp list (left for HR on purpose)`
        : ''),
    `boxes: ${summary.boxesStamped} stamped (or would be), ` +
      (summary.boxesFilled > 0 ? `${summary.boxesFilled} already filled, ` : '') +
      `${summary.boxesLeftAlone} left alone`,
    '',
    'by outcome:',
  ]
  for (const outcome of Object.values(STAMP_OUTCOMES)) {
    const count = summary.byOutcome[outcome]
    if (count) lines.push(`  ${String(count).padStart(5)}  ${STAMP_OUTCOME_LABEL[outcome]}`)
  }
  // First after the outcomes, because each one is a box somebody has to move.
  if (summary.checkTemplate.length > 0) {
    lines.push(
      '',
      `CHECK THE TEMPLATE - ${summary.checkTemplate.length} box(es) that should be empty were occupied:`,
    )
    for (const entry of summary.checkTemplate) {
      lines.push(`  #${entry.documentId}  ${entry.documentName}  ${entry.box} - ${entry.reason}`)
    }
  }
  if (summary.reasons.length > 0) {
    lines.push('', 'left alone because:')
    for (const { reason, count } of summary.reasons) {
      lines.push(`  ${String(count).padStart(5)}  ${reason}`)
    }
  }
  if (summary.filledBecause.length > 0) {
    lines.push('', 'taken as already filled because:')
    for (const { reason, count } of summary.filledBecause) {
      lines.push(`  ${String(count).padStart(5)}  ${reason}`)
    }
  }
  if (summary.finishedWithFilled.length > 0) {
    const ids = summary.finishedWithFilled
    const shown = ids
      .slice(0, IDS_SHOWN)
      .map((id) => `#${id}`)
      .join(' ')
    const more = ids.length > IDS_SHOWN ? ` and ${ids.length - IDS_SHOWN} more` : ''
    lines.push(
      '',
      `finished with a box taken as filled - spot-check these: ${ids.length}`,
      `  ${shown}${more}`,
    )
  }
  return lines
}

/**
 * One line per document for --redecide: what would be, or was, added, kept,
 * taken as filled and left, and where the document ends up. `wouldBecome` is
 * the status a real run would leave a previewed document in - the runner's
 * own statusAfter, so the dry run says what the real run does.
 */
export function formatRedecide(outcome: RedecideOutcome, wouldBecome?: SignatureStatus): string {
  const head = `#${outcome.documentId}  ${outcome.documentName}`
  if (outcome.kind === 'left') return `${head}  left alone: ${outcome.detail}`

  const preview = outcome.kind === 'preview'
  const decision = preview ? outcome.decision : outcome.result.decision
  const of = (action: StampBoxDecision['action']) =>
    decision.boxes.filter((box) => box.action === action)
  const add = of('stamp')
  const keep = of('keep')
  const filled = of('filled')
  const leave = of('skip')
  const parts = [
    add.length > 0 ? `${preview ? 'would add' : 'added'}: ${add.map(boxName).join(', ')}` : '',
    keep.length > 0
      ? `keep: ${keep.map((box) => `${boxName(box)} (${box.reason})`).join(', ')}`
      : '',
    filled.length > 0
      ? `already filled: ${filled.map((box) => `${boxName(box)} (${box.reason})`).join(', ')}`
      : '',
    leave.length > 0
      ? `leave: ${leave.map((box) => `${boxName(box)} - ${box.reason}`).join('; ')}`
      : '',
  ].filter((part) => part.length > 0)

  const painted = preview ? add.length > 0 : outcome.result.stamped > 0
  const landing = preview ? wouldBecome : outcome.result.status
  const status = landing
    ? `  -> ${preview ? 'would become ' : ''}${landing}${painted ? '' : ' (nothing painted)'}`
    : ''
  return `${head}  ${parts.join('; ') || STAMP_OUTCOME_LABEL[decision.outcome]}${status}`
}
