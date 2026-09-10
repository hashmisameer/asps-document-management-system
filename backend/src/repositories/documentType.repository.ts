import {
  ALL_DOCUMENT_FIELDS,
  checklistRuleFor,
  type DeadlineUnit,
  type DocumentField,
  type DocumentType,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'
import { logger } from '../utils/logger.js'

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
  RequiredFields: string | null
  RecognitionKeywords: string | null
  RefuseOnCheckFailure: boolean
  RequiredAtCreation: boolean
  CanBeMarkedNotRequired: boolean
  CreatedAt: Date
  UpdatedAt: Date
}

const SELECT_DOCUMENT_TYPE = `
    SELECT  dt.DocumentTypeId, dt.DocumentName, dt.DocumentCode, dt.IsMandatory,
            dt.IsActive, dt.RequiresSignature, dt.DeadlineValue, dt.DeadlineUnit,
            dt.SortOrder, dt.RequiredFields, dt.RecognitionKeywords,
            dt.RefuseOnCheckFailure, dt.RequiredAtCreation, dt.CanBeMarkedNotRequired,
            dt.CreatedAt, dt.UpdatedAt
    FROM    dbo.DocumentTypes AS dt`

function toDeadlineUnit(value: string | null): DeadlineUnit | null {
  if (value === 'DAY' || value === 'MONTH') return value
  // CK_DocTypes_DeadlineUnit makes anything else impossible, so a value here
  // means the constraint was dropped. Treating it as "no deadline" is the safe
  // reading: it cannot manufacture a due date out of a value we cannot parse.
  return null
}

/**
 * The identity check's field list, as stored: 'EmployeeName,JoiningDate'.
 *
 * An unrecognised code is DROPPED rather than passed on. A field nothing knows
 * how to compare cannot be checked, and carrying it forward would either crash
 * the check or - worse - quietly count as satisfied.
 */
/**
 * The recognition phrases, split and tidied.
 *
 * Unlike the field codes beside them these are free text - whatever wording a
 * real document turns out to carry - so there is nothing to validate against
 * and nothing to warn about. Blank entries are dropped so a trailing comma in
 * the configuration cannot become a keyword that matches everything.
 */
function parseKeywords(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
}

function parseRequiredFields(value: string | null): DocumentField[] {
  if (!value) return []
  const known = new Set<string>(ALL_DOCUMENT_FIELDS)
  const parsed: DocumentField[] = []

  for (const raw of value.split(',')) {
    const code = raw.trim()
    if (code.length === 0) continue
    if (known.has(code)) {
      parsed.push(code as DocumentField)
    } else {
      logger.warn({ code }, 'Unknown field code in DocumentTypes.RequiredFields; ignoring it')
    }
  }
  return parsed
}

/**
 * A stored row, with the checklist's decisions laid over it.
 *
 * Whether a document is mandatory and when it falls due are decided in
 * shared/src/constants/documentChecklist.ts, not in this table. The columns are
 * still written - a migration keeps them in step so that SQL which filters on
 * IsMandatory agrees with the application - but the list is what is believed.
 *
 * A type the list does not name keeps what the row says: this list speaks for
 * the documents it names and does not silently take over the ones it does not.
 */
function toDocumentType(row: DocumentTypeRow): DocumentType {
  const rule = checklistRuleFor(row.DocumentCode)

  return {
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    documentCode: row.DocumentCode,
    isActive: row.IsActive,
    requiresSignature: row.RequiresSignature,
    isMandatory: rule?.isMandatory ?? row.IsMandatory,
    deadlineValue: rule === undefined ? row.DeadlineValue : rule.deadlineValue,
    deadlineUnit: rule === undefined ? toDeadlineUnit(row.DeadlineUnit) : rule.deadlineUnit,
    sortOrder: row.SortOrder,
    requiredFields: parseRequiredFields(row.RequiredFields),
    recognitionKeywords: parseKeywords(row.RecognitionKeywords),
    refuseOnCheckFailure: row.RefuseOnCheckFailure,
    requiredAtCreation: row.RequiredAtCreation,
    canBeMarkedNotRequired: row.CanBeMarkedNotRequired,
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
