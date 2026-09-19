import { variantKey, type DocumentShapeGroup, type DocumentTypeShapes } from '@asps-dms/shared'

/**
 * The shape filter on the template editor's sample list.
 *
 * A type's stored documents come in a few shapes, and a template covers one.
 * The administrator's job is to draw a template for each shape that has none,
 * so the sample list is filtered BY SHAPE and opens on a shape that still
 * needs one: the largest such, because that is the most documents waiting.
 * Once every shape has a template it opens on the largest.
 *
 * A shape is named here by its key - '1p-portrait-1.41' - which is stable
 * for the session and fine in a URL; a person never sees it, they see the
 * label. Kept apart from the page so the choices can be tested without one.
 */

export const ALL_SHAPES = 'all'

/** The shape the editor should open on when nobody has chosen one. */
export function defaultShapeKey(shapes: DocumentTypeShapes | undefined): string | null {
  if (!shapes || shapes.groups.length === 0) return null
  // Groups arrive largest first, so the first without a template is the
  // biggest piece of work left.
  const uncovered = shapes.groups.find((group) => !group.hasTemplate)
  return variantKey((uncovered ?? shapes.groups[0]!).variant)
}

export interface ShapeOption {
  value: string
  label: string
  hasTemplate: boolean | null
}

/** The filter's choices: every shape, marked, and 'all'. */
export function shapeOptions(shapes: DocumentTypeShapes | undefined): ShapeOption[] {
  if (!shapes) return []
  const options: ShapeOption[] = shapes.groups.map((group) => ({
    value: variantKey(group.variant),
    label:
      `${group.label} - ${group.documents} document${group.documents === 1 ? '' : 's'} - ` +
      (group.hasTemplate ? 'template saved' : 'no template yet'),
    hasTemplate: group.hasTemplate,
  }))
  options.push({ value: ALL_SHAPES, label: 'All shapes', hasTemplate: null })
  return options
}

/** The group a filter key names, or null for 'all' and for a key no longer there. */
export function groupForKey(
  shapes: DocumentTypeShapes | undefined,
  key: string | null,
): DocumentShapeGroup | null {
  if (!shapes || !key || key === ALL_SHAPES) return null
  return shapes.groups.find((group) => variantKey(group.variant) === key) ?? null
}

/**
 * The samples to offer: the ones in the chosen shape, or all of them.
 *
 * Before the shapes have been measured, or when the chosen shape has gone
 * (its documents removed), every sample is offered rather than none.
 */
export function filterSamples<T extends { documentId: number }>(
  items: readonly T[],
  shapes: DocumentTypeShapes | undefined,
  key: string | null,
): T[] {
  const group = groupForKey(shapes, key)
  if (!group) return [...items]
  const allowed = new Set(group.documentIds)
  return items.filter((item) => allowed.has(item.documentId))
}

/**
 * The line above the list: how many shapes, how many covered, and how much
 * of the type the templates reach.
 */
export function shapesSummary(
  shapes: DocumentTypeShapes | undefined,
  typeName: string,
): string | null {
  if (!shapes) return null
  const names = `${typeName}${typeName.endsWith('s') ? '' : 's'}`
  if (shapes.measured === 0) return `No stored ${names} could be measured yet.`

  const total = shapes.groups.length
  const covered = shapes.groups.filter((group) => group.hasTemplate)
  const coveredDocuments = covered.reduce((sum, group) => sum + group.documents, 0)
  const percent = Math.round((coveredDocuments / shapes.measured) * 100)

  const shapesWord = total === 1 ? '1 shape' : `${total} shapes`
  const withWord = `${covered.length} with a template, ${total - covered.length} without`
  return (
    `${shapesWord}: ${withWord}. Templates cover ${coveredDocuments} of ${shapes.measured} ` +
    `stored ${names} (${percent}%).`
  )
}
