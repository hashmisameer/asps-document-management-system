import type {
  DocumentTypePlacement,
  DocumentTypeTemplateSummary,
  SaveTemplateInput,
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

export async function saveTemplate(
  documentTypeId: number,
  input: SaveTemplateInput,
): Promise<DocumentTypePlacement[]> {
  const response = await api.put<{ placements: DocumentTypePlacement[] }>(
    `/document-types/${documentTypeId}/placements`,
    input,
  )
  return response.data.placements
}

export const templateKeys = {
  all: ['templates'] as const,
  summaries: ['templates', 'summaries'] as const,
  forType: (documentTypeId: number) => ['templates', documentTypeId] as const,
}
