import {
  sameShape,
  shapeOf,
  variantLabel,
  type DocumentShapeGroup,
  type DocumentTypeShapes,
  type TemplateVariant,
} from '@asps-dms/shared'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import { logger } from '../utils/logger.js'
import { measurePdf } from './stampCheck.service.js'
import * as storage from './storage.service.js'

/**
 * The shapes of a type's documents: which pages, in what proportions, and
 * how many of each.
 *
 * What answers 'how many templates does Appointment Letter need', and what
 * the template editor shows beside a sample: this sample is A4 portrait, 1
 * page, and so are 118 of the 121 stored. Measured from the files - the row
 * records a page count and not a size - and grouped the way templates match,
 * so a group IS what one template covers.
 *
 * MEASURING IS SLOW ENOUGH TO CACHE. Opening every PDF of a type to read its
 * first page is a second or two for a hundred documents, and the editor asks
 * on every load. The answer is kept per type until the type's stored files
 * change - a new upload, a replacement, a removal - which the row count and
 * latest UpdatedAt together notice. A measured size never changes for a
 * given file, so the per-document measurements are kept too and only the new
 * files are opened.
 */

const cacheByType = new Map<
  number,
  { stamp: string; measurements: Map<number, Measurement>; shapes: DocumentTypeShapes }
>()

type Measurement = { variant: TemplateVariant } | { unmeasured: true }

/** What the type's stored files look like right now, as one string. */
function stampOf(files: readonly { documentId: number; updatedAt: Date }[]): string {
  const latest = files.reduce((max, file) => Math.max(max, file.updatedAt.getTime()), 0)
  return `${files.length}:${latest}:${files.map((f) => f.documentId).join(',')}`
}

async function measure(file: {
  mimeType: string | null
  originalFilePath: string
}): Promise<Measurement> {
  if ((file.mimeType ?? 'application/pdf') !== 'application/pdf') return { unmeasured: true }
  try {
    const source = await storage.readStoredFile(file.originalFilePath)
    return { variant: await measurePdf(source) }
  } catch (error) {
    logger.warn({ err: error, path: file.originalFilePath }, 'Could not measure a stored PDF')
    return { unmeasured: true }
  }
}

/**
 * Groups measured pages by shape, largest group first.
 *
 * Greedy, in order of proportion: a page joins the first group within
 * tolerance of the group's FIRST member, so a group never drifts wider than
 * one tolerance from where it started.
 */
export function groupByShape(
  measured: readonly { documentId: number; variant: TemplateVariant }[],
  templates: readonly TemplateVariant[],
  total: number,
): DocumentShapeGroup[] {
  const groups: {
    first: TemplateVariant
    members: { documentId: number; variant: TemplateVariant }[]
  }[] = []

  const ordered = [...measured].sort(
    (a, b) => shapeOf(a.variant).aspect - shapeOf(b.variant).aspect,
  )
  for (const item of ordered) {
    const group = groups.find((g) => sameShape(shapeOf(g.first), shapeOf(item.variant)))
    if (group) group.members.push(item)
    else groups.push({ first: item.variant, members: [item] })
  }

  return groups
    .map((group) => {
      const sizeCounts = new Map<string, number>()
      for (const member of group.members) {
        const size = `${member.variant.widthPt}x${member.variant.heightPt}`
        sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1)
      }
      return {
        variant: group.first,
        label: variantLabel(group.first),
        documents: group.members.length,
        percent: total > 0 ? Math.round((group.members.length / total) * 100) : 0,
        sizes: [...sizeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([size, count]) => `${size} (${count})`),
        hasTemplate: templates.some((template) =>
          sameShape(shapeOf(template), shapeOf(group.first)),
        ),
        documentIds: group.members.map((member) => member.documentId),
      }
    })
    .sort((a, b) => b.documents - a.documents)
}

/** The shapes of one type's stored documents, measured and cached. */
export async function shapesForType(documentTypeId: number): Promise<DocumentTypeShapes> {
  const files = await employeeDocumentRepository.listStoredFilesOfType(documentTypeId)
  const templateRows = await documentTypePlacementRepository.listForType(documentTypeId)
  const templates = templateRows.map((row) => row.variant)
  const stamp = `${stampOf(files)}|${templates.map((t) => `${t.pageCount}-${t.widthPt}-${t.heightPt}`).join(',')}`

  const cached = cacheByType.get(documentTypeId)
  if (cached && cached.stamp === stamp) return cached.shapes

  // Only the files not measured before are opened.
  const measurements = new Map<number, Measurement>()
  for (const file of files) {
    const known = cached?.measurements.get(file.documentId)
    measurements.set(file.documentId, known ?? (await measure(file)))
  }

  const measured: { documentId: number; variant: TemplateVariant }[] = []
  let unmeasured = 0
  for (const [documentId, measurement] of measurements) {
    if ('variant' in measurement) measured.push({ documentId, variant: measurement.variant })
    else unmeasured += 1
  }

  const shapes: DocumentTypeShapes = {
    documentTypeId,
    measured: measured.length,
    unmeasured,
    groups: groupByShape(measured, templates, measured.length),
  }
  cacheByType.set(documentTypeId, { stamp, measurements, shapes })
  return shapes
}

/** For tests, and for a process that wants a fresh look. */
export function forgetShapes(): void {
  cacheByType.clear()
}
