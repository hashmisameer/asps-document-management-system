import type { DeadlineUnit, DocumentType } from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.DocumentTypes access.
 *
 * The checklist is configuration, not code (Section 15): adding a document type
 * is a row here, and no route, service or component changes. Everything that
 * needs to know what documents exist reads them from this table.
 */

interface DocumentTypeRow {
  DocumentTypeId: number
  DocumentName: string
  DocumentCode: string
  IsMandatory: boolean
  IsActive: boolean
  RequiresSignature: boolean
  DeadlineValue: number | null
  DeadlineUnit: string | null
  SortOrder: number
  CreatedAt: Date
  UpdatedAt: Date
}

const SELECT_DOCUMENT_TYPE = `
    SELECT  dt.DocumentTypeId, dt.DocumentName, dt.DocumentCode, dt.IsMandatory,
            dt.IsActive, dt.RequiresSignature, dt.DeadlineValue, dt.DeadlineUnit,
            dt.SortOrder, dt.CreatedAt, dt.UpdatedAt
    FROM    dbo.DocumentTypes AS dt`

function toDeadlineUnit(value: string | null): DeadlineUnit | null {
  if (value === 'DAY' || value === 'MONTH') return value
  // CK_DocTypes_DeadlineUnit makes anything else impossible, so a value here
  // means the constraint was dropped. Treating it as "no deadline" is the safe
  // reading: it cannot manufacture a due date out of a value we cannot parse.
  return null
}

function toDocumentType(row: DocumentTypeRow): DocumentType {
  return {
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    documentCode: row.DocumentCode,
    isMandatory: row.IsMandatory,
    isActive: row.IsActive,
    requiresSignature: row.RequiresSignature,
    deadlineValue: row.DeadlineValue,
    deadlineUnit: toDeadlineUnit(row.DeadlineUnit),
    sortOrder: row.SortOrder,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

/**
 * Every active document type, in display order.
 *
 * Takes an optional transaction because employee creation reads this list and
 * writes the resulting checklist in one unit of work: the checklist must be
 * built from the types as they are inside that transaction, not from a list
 * read a moment earlier.
 */
export async function listActive(transaction?: sql.Transaction): Promise<DocumentType[]> {
  const request = await createRequest(transaction)
  const result = await request.query<DocumentTypeRow>(
    `${SELECT_DOCUMENT_TYPE} WHERE dt.IsActive = 1 ORDER BY dt.SortOrder, dt.DocumentName`,
  )
  return result.recordset.map(toDocumentType)
}

export async function listAll(includeInactive: boolean): Promise<DocumentType[]> {
  if (!includeInactive) return listActive()

  const request = await createRequest()
  const result = await request.query<DocumentTypeRow>(
    `${SELECT_DOCUMENT_TYPE} ORDER BY dt.IsActive DESC, dt.SortOrder, dt.DocumentName`,
  )
  return result.recordset.map(toDocumentType)
}

export async function findById(documentTypeId: number): Promise<DocumentType | null> {
  const request = await createRequest()
  const result = await request
    .input('documentTypeId', sql.Int, documentTypeId)
    .query<DocumentTypeRow>(`${SELECT_DOCUMENT_TYPE} WHERE dt.DocumentTypeId = @documentTypeId`)

  const row = result.recordset[0]
  return row ? toDocumentType(row) : null
}
