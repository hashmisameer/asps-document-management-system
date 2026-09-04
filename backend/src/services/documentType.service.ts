import type { DocumentType, DocumentTypeListQuery } from '@asps-dms/shared'
import * as documentTypeRepository from '../repositories/documentType.repository.js'

/**
 * Document type configuration (Section 15).
 *
 * READ-ONLY, and deliberately so. What the checklist asks for - the ten
 * documents, which are mandatory, and how long people have to bring them - is
 * decided in shared/src/constants/documentChecklist.ts and applied over these
 * rows as they are read. There was a Settings screen that wrote it into the
 * table; the office asked for it back in code, because the list has been the
 * same for years and a screen that can change it is a screen somebody changes
 * by accident on a Friday.
 *
 * The table still holds a row per type, because every checklist row points at
 * one and a file uploaded years ago has to keep pointing at something.
 */
export async function list(query: DocumentTypeListQuery): Promise<DocumentType[]> {
  return documentTypeRepository.listAll(query.includeInactive)
}
