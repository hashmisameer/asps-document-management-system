import type { DocumentType, DocumentTypeListQuery } from '@asps-dms/shared'
import * as documentTypeRepository from '../repositories/documentType.repository.js'

/**
 * Document type configuration (Section 15).
 *
 * Read-only for now. The checklist is seeded from database/seeds, and the
 * screens that let HR add and edit a type arrive with Settings - at which point
 * creating a type must also decide what happens to employees who already exist,
 * because their checklists were materialised without it.
 */
export async function list(query: DocumentTypeListQuery): Promise<DocumentType[]> {
  return documentTypeRepository.listAll(query.includeInactive)
}
