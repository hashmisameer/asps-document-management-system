/**
 * Which form a PDF is: its page count and the SHAPE of its first page.
 *
 * A document type on the checklist can be more than one piece of paper -
 * 'PF Form / Form 11' is a two-page form for some employees and a one-page
 * form for others - and each has its own template. The variant is how a
 * template and an upload are matched, and it is decided by what the PDF IS,
 * not by anything a person picks.
 *
 * SHAPE, NOT SIZE, since 2026-09-18. The office's generated forms come out at
 * twenty slightly different sizes for one document type - 595x842, 595x841,
 * 596x842, whatever the printer driver and the re-save did - and a template
 * keyed on the exact size wanted twenty templates for one form. The boxes are
 * stored as fractions of the page and stamped onto whatever size arrives, so
 * the size was never what mattered. What matters is that the page is the
 * same SHAPE: the same way up, and the same proportions, so a box drawn at
 * 60% across lands on the same printed line.
 *
 * Proportion is judged to ONE PER CENT. A4 is 1.414 to 1 and Letter 1.294, a
 * difference of nine per cent: they are different shapes, and a template for
 * one is never used on the other. A box in the wrong place is worse than a
 * document HR has to sign by hand. 595x841 against 595x842 is a tenth of a
 * per cent: one shape.
 */
export interface TemplateVariant {
  pageCount: number
  /** The first page, unrotated, rounded to whole points - the sample it was drawn on. */
  widthPt: number
  heightPt: number
}

export type PageOrientation = 'portrait' | 'landscape' | 'square'

/** What a template covers: pages, which way up, and how long for its width. */
export interface PageShape {
  pageCount: number
  orientation: PageOrientation
  /** Long side over short side. 1.414 for A4, 1.294 for Letter, 1 for square. */
  aspect: number
}

/** Rounds a measured page to the variant it belongs to. */
export function toVariant(pageCount: number, widthPt: number, heightPt: number): TemplateVariant {
  return { pageCount, widthPt: Math.round(widthPt), heightPt: Math.round(heightPt) }
}

/**
 * Pages within this of square are square: neither portrait nor landscape,
 * and matching neither. Only an identity card scan comes close.
 */
const SQUARE_BELOW = 1.05

/** How far two proportions may differ, relative, and still be one shape. */
export const SHAPE_TOLERANCE = 0.01

export function shapeOf(page: { pageCount: number; widthPt: number; heightPt: number }): PageShape {
  const long = Math.max(page.widthPt, page.heightPt)
  const short = Math.min(page.widthPt, page.heightPt)
  const aspect = short > 0 ? long / short : 1
  const orientation: PageOrientation =
    aspect < SQUARE_BELOW ? 'square' : page.widthPt < page.heightPt ? 'portrait' : 'landscape'
  return { pageCount: page.pageCount, orientation, aspect }
}

/**
 * Whether two pages are one shape: the same page count, exactly; the same
 * way up; and proportions within one per cent of each other. The page count
 * is never approximated - a one-page form and a two-page form are different
 * papers however alike their first pages are.
 */
export function sameShape(a: PageShape, b: PageShape, tolerance = SHAPE_TOLERANCE): boolean {
  return (
    a.pageCount === b.pageCount &&
    a.orientation === b.orientation &&
    Math.abs(a.aspect - b.aspect) <= tolerance * Math.max(a.aspect, b.aspect)
  )
}

/**
 * The one string that names a shape, for grouping and display. NOT for
 * matching: 1.414 and 1.415 round apart at some boundary, and a template must
 * not stop matching because a re-save moved the page by a point. Match with
 * sameShape; group and label with this.
 */
export function variantKey(variant: TemplateVariant): string {
  const shape = shapeOf(variant)
  return `${shape.pageCount}p-${shape.orientation}-${shape.aspect.toFixed(2)}`
}

export function sameVariant(a: TemplateVariant, b: TemplateVariant): boolean {
  return sameShape(shapeOf(a), shapeOf(b))
}

/**
 * The key of one SAVED template: its page count and the exact size of the
 * sample it was drawn on. This is what the rows record, and what tells two
 * templates of one shape apart. Before matching went by shape, every template
 * was keyed on this, and the ones saved then are still stored under it.
 *
 * The stamper collects a template's boxes by THIS key, never by variantKey:
 * two templates that round to the same shape are two templates, and only one
 * of them is stamped from.
 */
export function exactVariantKey(variant: TemplateVariant): string {
  return `${variant.pageCount}p-${variant.widthPt}x${variant.heightPt}`
}

/**
 * Kept for the template editor's collision warning: a re-save that moved the
 * page by up to this many points is still, to a person, the same sample.
 */
export const VARIANT_SIZE_SLACK_PT = 2

/**
 * Whether an uploaded document is a given variant: the same page count,
 * exactly, and the first page the same shape.
 */
export function variantMatches(
  variant: TemplateVariant,
  document: { pageCount: number; widthPt: number; heightPt: number },
  tolerance: number = SHAPE_TOLERANCE,
): boolean {
  return sameShape(shapeOf(variant), shapeOf(document), tolerance)
}

/**
 * The variant an upload belongs to, or null.
 *
 * Null when none matches, and null when more than one does - a document that
 * two templates both claim is not stamped from either. Nothing here picks the
 * nearest.
 */
export function findVariant<T extends TemplateVariant>(
  variants: readonly T[],
  document: { pageCount: number; widthPt: number; heightPt: number },
): T | null {
  const matching = variants.filter((variant) => variantMatches(variant, document))
  return matching.length === 1 ? (matching[0] ?? null) : null
}

/** The paper sizes a person has a name for, by proportion. */
const NAMED_PAPERS: readonly { name: string; aspect: number }[] = [
  { name: 'A4', aspect: 842 / 595 },
  { name: 'Letter', aspect: 792 / 612 },
  { name: 'Legal', aspect: 1008 / 612 },
]

/**
 * 'A4 portrait', 'Letter landscape', or 'portrait, 1.38 to 1' for a shape
 * nobody has a name for. Named by proportion, not by size: every A4-shaped
 * page is 'A4' here, whatever its point size.
 */
export function paperSizeLabel(widthPt: number, heightPt: number): string {
  const shape = shapeOf({ pageCount: 1, widthPt, heightPt })
  if (shape.orientation === 'square') return 'square'
  const named = NAMED_PAPERS.find(
    (paper) => Math.abs(paper.aspect - shape.aspect) <= SHAPE_TOLERANCE * paper.aspect,
  )
  return named
    ? `${named.name} ${shape.orientation}`
    : `${shape.orientation}, ${shape.aspect.toFixed(2)} to 1`
}

/** 'A4 portrait, 2 pages'. */
export function variantLabel(variant: TemplateVariant): string {
  const pages = variant.pageCount === 1 ? '1 page' : `${variant.pageCount} pages`
  return `${paperSizeLabel(variant.widthPt, variant.heightPt)}, ${pages}`
}
