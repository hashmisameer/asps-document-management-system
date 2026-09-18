import type {
  DocumentTypePlacement,
  DocumentTypeShapes,
  DocumentTypeTemplateSummary,
  SaveTemplateInput,
  TemplateVariant,
} from '@asps-dms/shared'
import { api } from '../../lib/api.js'

/**
 * Placement templates: where the boxes go on every document of a type.
 *
 * Read and written against the TYPE, never a document. Saving one stamps
 * nothing; it records coordinates for the uploads to come.
 */

export async function fetchTemplateSummaries(): Promise<DocumentTypeTemplateSummary[]> {
  const response = await api.get<{ templates: DocumentTypeTemplateSummary[] }>(
    '/document-types/placements',
  )
  return response.data.templates
}

export async function fetchTemplate(documentTypeId: number): Promise<DocumentTypePlacement[]> {
  const response = await api.get<{ placements: DocumentTypePlacement[] }>(
    `/document-types/${documentTypeId}/placements`,
  )
  return response.data.placements
}

export interface SavedTemplate {
  placements: DocumentTypePlacement[]
  /** The variant the save wrote. */
  variant: TemplateVariant
  /** True when a template for this variant existed and was replaced. */
  replacedExisting: boolean
}

/** Saves ONE VARIANT of a type's template; the type's other variants are untouched. */
export async function saveTemplate(
  documentTypeId: number,
  input: SaveTemplateInput,
): Promise<SavedTemplate> {
  const response = await api.put<SavedTemplate>(
    `/document-types/${documentTypeId}/placements`,
    input,
  )
  return response.data
}

/**
 * The shapes of the type's stored documents, measured from the files.
 *
 * Slow the first time for a type with hundreds of documents - the server
 * opens each PDF once and then remembers - so it is asked for once per
 * editor visit and never blocks the page.
 */
export async function fetchShapes(documentTypeId: number): Promise<DocumentTypeShapes> {
  const response = await api.get<{ shapes: DocumentTypeShapes }>(
    `/document-types/${documentTypeId}/shapes`,
  )
  return response.data.shapes
}

export const templateKeys = {
  all: ['templates'] as const,
  summaries: ['templates', 'summaries'] as const,
  forType: (documentTypeId: number) => ['templates', documentTypeId] as const,
  shapes: (documentTypeId: number) => ['templates', documentTypeId, 'shapes'] as const,
}
