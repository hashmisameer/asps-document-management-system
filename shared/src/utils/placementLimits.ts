import type { SignerRole } from '../constants/documents.js'

/**
 * How many boxes of one signer role a page of a document may hold.
 *
 * The guard against a second signature on a page that already has one: the
 * editor opens on stamped documents now, and one extra 'Add box' click must
 * not be able to put the employee's signature on a page twice.
 *
 * THE LIMIT COMES FROM THE TEMPLATE, never from a list of document types. A
 * page may hold as many boxes of a role as the type's template draws there -
 * the ESIC form's page 1 has two HR boxes, one beside the employee and one
 * under the photograph - and at least one, so a type with no template can
 * still be signed by hand. A rule that named a type would go stale the day
 * its template changed, and nobody would remember to update it.
 *
 * NEVER BELOW WHAT THE DOCUMENT ALREADY HOLDS. A document placed by hand
 * before this rule existed may carry more than its template allows; it can
 * still be saved exactly as it is. It just cannot gain another.
 *
 * WHERE VARIANTS SHARE A PAGE COUNT, THE HIGHEST COUNT WINS - deliberately.
 * Which variant a document is cannot be known without reading its PDF, and
 * a type's variants are told apart by page count first; two variants of the
 * same page count are counted together, and the larger number of boxes for a
 * page and role is the limit. That errs towards ALLOWING a box, never
 * towards refusing one a real form needs. A document whose page count is not
 * known is counted against every variant, for the same reason.
 */

export interface PlacementLimit {
  pageNumber: number
  signerRole: SignerRole
  max: number
}

interface Boxed {
  pageNumber: number
  signerRole: SignerRole
}

interface TemplateBoxed extends Boxed {
  /** Which saved form the row belongs to: its page count and its size. */
  variant: { pageCount: number; widthPt: number; heightPt: number }
}

function key(pageNumber: number, signerRole: SignerRole): string {
  return `${pageNumber}|${signerRole}`
}

function countByPageAndRole(boxes: readonly Boxed[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const box of boxes) {
    const at = key(box.pageNumber, box.signerRole)
    counts.set(at, (counts.get(at) ?? 0) + 1)
  }
  return counts
}

/**
 * The limit for every page and role the template or the document mentions.
 * Anything not listed is limited to one - see limitFor.
 */
export function placementLimits(
  templateRows: readonly TemplateBoxed[],
  documentPageCount: number | null,
  saved: readonly Boxed[],
): PlacementLimit[] {
  const rows =
    documentPageCount === null
      ? templateRows
      : templateRows.filter((row) => row.variant.pageCount === documentPageCount)

  // Each variant counted on its own - by its whole key, so two forms of the
  // same page count are compared and never added together - then the
  // largest taken per page and role.
  const byVariant = new Map<string, TemplateBoxed[]>()
  for (const row of rows) {
    const variant = `${row.variant.pageCount}-${row.variant.widthPt}x${row.variant.heightPt}`
    byVariant.set(variant, [...(byVariant.get(variant) ?? []), row])
  }
  const limits = new Map<string, PlacementLimit>()
  const raise = (pageNumber: number, signerRole: SignerRole, count: number) => {
    const at = key(pageNumber, signerRole)
    const max = Math.max(1, count, limits.get(at)?.max ?? 0)
    limits.set(at, { pageNumber, signerRole, max })
  }

  for (const boxes of byVariant.values()) {
    for (const [at, count] of countByPageAndRole(boxes)) {
      const [page, role] = at.split('|') as [string, SignerRole]
      raise(Number(page), role, count)
    }
  }
  for (const [at, count] of countByPageAndRole(saved)) {
    const [page, role] = at.split('|') as [string, SignerRole]
    raise(Number(page), role, count)
  }

  return [...limits.values()].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.signerRole.localeCompare(b.signerRole),
  )
}

/** The most boxes of this role this page may hold: its limit, or one. */
export function limitFor(
  limits: readonly PlacementLimit[],
  pageNumber: number,
  signerRole: SignerRole,
): number {
  return (
    limits.find((limit) => limit.pageNumber === pageNumber && limit.signerRole === signerRole)
      ?.max ?? 1
  )
}

/** The pages and roles a set of boxes holds more of than it may. Empty when none. */
export function overLimit(
  boxes: readonly Boxed[],
  limits: readonly PlacementLimit[],
): { pageNumber: number; signerRole: SignerRole; count: number; max: number }[] {
  return [...countByPageAndRole(boxes)]
    .map(([at, count]) => {
      const [page, role] = at.split('|') as [string, SignerRole]
      const pageNumber = Number(page)
      return { pageNumber, signerRole: role, count, max: limitFor(limits, pageNumber, role) }
    })
    .filter((entry) => entry.count > entry.max)
    .sort((a, b) => a.pageNumber - b.pageNumber || a.signerRole.localeCompare(b.signerRole))
}

/** Whether one more box of this role may go on this page. */
export function canAddBox(
  boxes: readonly Boxed[],
  limits: readonly PlacementLimit[],
  pageNumber: number,
  signerRole: SignerRole,
): boolean {
  const onPage = boxes.filter(
    (box) => box.pageNumber === pageNumber && box.signerRole === signerRole,
  ).length
  return onPage < limitFor(limits, pageNumber, signerRole)
}
