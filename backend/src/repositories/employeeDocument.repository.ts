import {
  DOCUMENT_STATUS,
  SIGNATURE_STATUS,
  formatDateOnly,
  parseDateOnly,
  type DocumentStatus,
  type EmployeeDocument,
  type SignatureStatus,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.EmployeeDocuments access.
 *
 * One row per (employee, document type), materialised as 'Pending' when the
 * employee is created. That is what turns "what is still outstanding" into a
 * plain indexed query instead of a cross join computed at read time.
 *
 * Deadline STATE is not read from here. The row carries DueDate; whether that
 * is overdue, due soon or not due is derived by the shared rules at read time,
 * so it is correct the moment it is looked at (standing assumption 4).
 */

/** A checklist row as stored: everything except the derived deadline fields. */
export type EmployeeDocumentRecord = Omit<EmployeeDocument, 'deadlineState' | 'daysRemaining'>

interface EmployeeDocumentRow {
  DocumentId: number
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  DocumentTypeId: number
  DocumentName: string
  IsMandatory: boolean
  RequiresSignature: boolean
  OriginalFileName: string | null
  FileSizeBytes: string | number | null
  MimeType: string | null
  PageCount: number | null
  ProcessedFilePath: string | null
  Status: string
  SignatureStatus: string
  DueDate: Date | null
  UploadedByName: string | null
  UploadedAt: Date | null
  VerifiedByName: string | null
  VerifiedAt: Date | null
  RejectionReason: string | null
  CreatedAt: Date
  UpdatedAt: Date
}

const SELECT_EMPLOYEE_DOCUMENT = `
    SELECT  d.DocumentId, d.EmployeeId, e.EmployeeCode, e.EmployeeName,
            d.DocumentTypeId, dt.DocumentName, dt.IsMandatory, dt.RequiresSignature,
            d.OriginalFileName, d.FileSizeBytes, d.MimeType, d.PageCount,
            d.ProcessedFilePath, d.Status, d.SignatureStatus, d.DueDate,
            up.FullName AS UploadedByName, d.UploadedAt,
            vf.FullName AS VerifiedByName, d.VerifiedAt,
            d.RejectionReason, d.CreatedAt, d.UpdatedAt
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
    LEFT JOIN dbo.Users AS up ON up.UserId = d.UploadedBy
    LEFT JOIN dbo.Users AS vf ON vf.UserId = d.VerifiedBy`

function toDocumentStatus(value: string): DocumentStatus {
  // CK_EmpDocs_Status makes anything else impossible. If the constraint is ever
  // dropped, an unrecognised status must not silently read as complete.
  return (Object.values(DOCUMENT_STATUS) as string[]).includes(value)
    ? (value as DocumentStatus)
    : DOCUMENT_STATUS.PENDING
}

function toSignatureStatus(value: string): SignatureStatus {
  return (Object.values(SIGNATURE_STATUS) as string[]).includes(value)
    ? (value as SignatureStatus)
    : SIGNATURE_STATUS.NOT_REQUIRED
}

function toRecord(row: EmployeeDocumentRow): EmployeeDocumentRecord {
  return {
    documentId: row.DocumentId,
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    isMandatory: row.IsMandatory,
    requiresSignature: row.RequiresSignature,
    originalFileName: row.OriginalFileName,
    // BIGINT arrives as a string from tedious when it exceeds the safe integer
    // range; a file size never does, but Number() keeps the type honest.
    fileSizeBytes: row.FileSizeBytes === null ? null : Number(row.FileSizeBytes),
    mimeType: row.MimeType,
    pageCount: row.PageCount,
    // The path itself never crosses the API boundary - only whether there is one.
    hasProcessedFile: row.ProcessedFilePath !== null,
    status: toDocumentStatus(row.Status),
    signatureStatus: toSignatureStatus(row.SignatureStatus),
    dueDate: row.DueDate === null ? null : formatDateOnly(row.DueDate),
    uploadedByName: row.UploadedByName,
    uploadedAt: row.UploadedAt?.toISOString() ?? null,
    verifiedByName: row.VerifiedByName,
    verifiedAt: row.VerifiedAt?.toISOString() ?? null,
    rejectionReason: row.RejectionReason,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

export interface ChecklistItem {
  documentTypeId: number
  /** Computed by the shared deadline rules, or null when the type has none. */
  dueDate: string | null
}

/**
 * Materialises an employee's checklist.
 *
 * Called inside the transaction that creates the employee, so an employee can
 * never exist without their checklist. Every row starts Pending with no
 * signature work outstanding: signature detection begins when a file arrives,
 * not before there is anything to detect.
 *
 * The rows are inserted in one statement rather than one statement each. The
 * VALUES list is built from parameter NAMES - @typeId0, @dueDate0, ... - and
 * every value is still bound, so nothing a caller sent reaches the query text.
 */
export async function createChecklist(
  employeeId: number,
  items: readonly ChecklistItem[],
  transaction?: sql.Transaction,
): Promise<number> {
  if (items.length === 0) return 0

  const request = await createRequest(transaction)
  request
    .input('employeeId', sql.Int, employeeId)
    .input('status', sql.VarChar(20), DOCUMENT_STATUS.PENDING)
    .input('signatureStatus', sql.VarChar(20), SIGNATURE_STATUS.NOT_REQUIRED)

  const tuples = items.map((item, index) => {
    request.input(`typeId${index}`, sql.Int, item.documentTypeId)
    request.input(
      `dueDate${index}`,
      sql.Date,
      item.dueDate === null ? null : parseDateOnly(item.dueDate),
    )
    return `(@employeeId, @typeId${index}, @status, @signatureStatus, @dueDate${index})`
  })

  const VALUES_CLAUSE = tuples.join(', ')

  const result = await request.query(`
      INSERT INTO dbo.EmployeeDocuments
          (EmployeeId, DocumentTypeId, Status, SignatureStatus, DueDate)
      VALUES ${VALUES_CLAUSE}`)

  return result.rowsAffected[0] ?? 0
}

/**
 * An employee's checklist, in the document types' display order.
 *
 * Archived rows - the previous file behind a replacement - are excluded: only
 * the current document for each type is served (standing assumption 3).
 */
export async function listForEmployee(employeeId: number): Promise<EmployeeDocumentRecord[]> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .query<EmployeeDocumentRow>(`
      ${SELECT_EMPLOYEE_DOCUMENT}
      WHERE  d.EmployeeId = @employeeId AND d.IsActive = 1
      ORDER BY dt.SortOrder, dt.DocumentName`)

  return result.recordset.map(toRecord)
}

/** The document type ids an employee already has an active row for. */
export async function listDocumentTypeIdsForEmployee(employeeId: number): Promise<number[]> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .query<{ DocumentTypeId: number }>(`
      SELECT d.DocumentTypeId
      FROM   dbo.EmployeeDocuments AS d
      WHERE  d.EmployeeId = @employeeId AND d.IsActive = 1`)

  return result.recordset.map((row) => row.DocumentTypeId)
}
