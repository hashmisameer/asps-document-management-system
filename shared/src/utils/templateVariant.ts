/**
 * Which form a PDF is: its page count and its first page's size.
 *
 * A document type on the checklist can be more than one piece of paper -
 * 'PF Form / Form 11' is a two-page form for some employees and a one-page
 * form for others - and each has its own template. The variant is how a
 * template and an upload are matched, and it is decided by what the PDF IS,
 * not by anything a person picks.
 *
 * Sizes are WHOLE POINTS. A generated PDF re-saved through a printer driver
 * can move by a fraction of a point; a key that included the fraction would
 * make every such re-save a different form.
 */
export interface TemplateVariant {
  pageCount: number
  /** The first page, unrotated, rounded to whole points. */
  widthPt: number
  heightPt: number
}

/** Rounds a measured page to the variant it belongs to. */
export function toVariant(pageCount: number, widthPt: number, heightPt: number): TemplateVariant {
  return { pageCount, widthPt: Math.round(widthPt), heightPt: Math.round(heightPt) }
}

/** The one string that names a variant, for maps and comparisons. */
export function variantKey(variant: TemplateVariant): string {
  return `${variant.pageCount}p-${variant.widthPt}x${variant.heightPt}`
}

export function sameVariant(a: TemplateVariant, b: TemplateVariant): boolean {
  return variantKey(a) === variantKey(b)
}

/**
 * How far a page may be from a variant's size and still be that form.
 *
 * Two points. Enough for a re-save; not enough to mistake A4 for Letter,
 * which differ by seventeen points in width and fifty in height.
 */
export const VARIANT_SIZE_SLACK_PT = 2

/**
 * Whether an uploaded document is a given variant: the same page count,
 * exactly, and a first page within the slack. The page count is never
 * approximated - a one-page form and a two-page form are different papers
 * however alike their first pages are.
 */
export function variantMatches(
  variant: TemplateVariant,
  document: { pageCount: number; widthPt: number; heightPt: number },
  slackPt: number = VARIANT_SIZE_SLACK_PT,
): boolean {
  return (
    document.pageCount === variant.pageCount &&
    Math.abs(document.widthPt - variant.widthPt) <= slackPt &&
    Math.abs(document.heightPt - variant.heightPt) <= slackPt
  )
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

/** 'A4 portrait', or the size in points for anything else. */
export function paperSizeLabel(widthPt: number, heightPt: number): string {
  const near = (a: number, b: number) => Math.abs(a - b) <= VARIANT_SIZE_SLACK_PT
  if (near(widthPt, 595) && near(heightPt, 842)) return 'A4 portrait'
  if (near(widthPt, 842) && near(heightPt, 595)) return 'A4 landscape'
  if (near(widthPt, 612) && near(heightPt, 792)) return 'Letter portrait'
  if (near(widthPt, 792) && near(heightPt, 612)) return 'Letter landscape'
  return `${widthPt} x ${heightPt} pt`
}

/** '2-page form (A4 portrait)'. */
export function variantLabel(variant: TemplateVariant): string {
  const pages = `${variant.pageCount}-page form`
  return `${pages} (${paperSizeLabel(variant.widthPt, variant.heightPt)})`
}
