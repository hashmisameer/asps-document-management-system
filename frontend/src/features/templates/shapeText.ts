import {
  sameShape,
  shapeOf,
  variantLabel,
  type DocumentShapeGroup,
  type DocumentTypeShapes,
  type TemplateVariant,
} from '@asps-dms/shared'

/**
 * What the template editor says about the sample's shape.
 *
 * A template covers a SHAPE - every page of this type that is the same way
 * up and the same proportions - not one file. The editor says which shape
 * the sample is, how many of the type's documents it covers, and warns when
 * that is only a few: a sample that is a shape hardly anything else is, is
 * usually the wrong sample, and a template drawn on it stamps nothing else.
 *
 * Kept apart from the page so the sentences can be tested without a PDF.
 */

/** Fewer than this many documents, or under this share of the type, is rare. */
export const RARE_SHAPE_MIN_DOCUMENTS = 5
export const RARE_SHAPE_MIN_PERCENT = 5

export interface ShapeCoverage {
  /** 'A4 portrait, 1 page' */
  label: string
  /** The group this shape is, when the type's documents have been measured. */
  group: DocumentShapeGroup | null
  /** '118 of 121 Appointment Letters are this shape (98%)' */
  coverage: string | null
  /** The warning, when this shape is rare among the type's documents. Null otherwise. */
  warning: string | null
}

/** The group among a type's shapes that this sample belongs to, if any. */
export function groupFor(
  shapes: DocumentTypeShapes | undefined,
  variant: TemplateVariant,
): DocumentShapeGroup | null {
  if (!shapes) return null
  return shapes.groups.find((group) => sameShape(shapeOf(group.variant), shapeOf(variant))) ?? null
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

export function describeShape(
  variant: TemplateVariant,
  shapes: DocumentTypeShapes | undefined,
  typeName: string,
): ShapeCoverage {
  const label = variantLabel(variant)
  const group = groupFor(shapes, variant)
  const names = `${typeName}${typeName.endsWith('s') ? '' : 's'}`

  if (!shapes) return { label, group: null, coverage: null, warning: null }

  const total = shapes.measured
  const count = group?.documents ?? 0
  const percent = total > 0 ? Math.round((count / total) * 100) : 0
  const coverage =
    total === 0
      ? `No stored ${names} could be measured yet.`
      : `${count} of ${total} stored ${plural(total, typeName, names)} ${plural(count, 'is', 'are')} this shape (${percent}%).`

  // Rare: few documents, or a small share. Not when there is only a handful
  // of documents altogether - three of three is not rare, it is all of them.
  const rare =
    total >= RARE_SHAPE_MIN_DOCUMENTS &&
    (count < RARE_SHAPE_MIN_DOCUMENTS || percent < RARE_SHAPE_MIN_PERCENT)

  const commonest = shapes.groups[0]
  const warning = rare
    ? `Only ${count} of ${total} stored ${names} ${plural(count, 'is', 'are')} ${label}. ` +
      `A template drawn on this sample will be used for ${plural(count, 'that document', 'those documents')} and no others` +
      (commonest && commonest.documents > count
        ? `; ${commonest.documents} are ${commonest.label}. Is this the right sample?`
        : '. Is this the right sample?')
    : null

  return { label, group, coverage, warning }
}

/** Whether a sample document is the same shape as the one on screen. */
export function sampleIsCovered(
  shapes: DocumentTypeShapes | undefined,
  variant: TemplateVariant | null,
  documentId: number,
): boolean | null {
  if (!shapes || !variant) return null
  const group = groupFor(shapes, variant)
  return group ? group.documentIds.includes(documentId) : false
}

/**
 * What the Templates screen says when a shape holds more than one saved
 * template. Null when it holds one, which is the normal case.
 *
 * Templates saved when the key was the exact page size can be several to a
 * shape; the stamper uses the newest, and saving the shape once in the editor
 * replaces them all. Said plainly, as a fact and a one-click remedy - not as
 * an error, because nothing is wrong with the newest.
 */
export function savedTemplatesNote(savedTemplates: number): string | null {
  if (savedTemplates <= 1) return null
  return `${savedTemplates} saved templates are this shape - the newest is used. Save it once to keep only that one.`
}
