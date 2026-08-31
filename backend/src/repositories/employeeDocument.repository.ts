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

export async function findById(documentId: number): Promise<EmployeeDocumentRecord | null> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .query<EmployeeDocumentRow>(`
      ${SELECT_EMPLOYEE_DOCUMENT}
      WHERE  d.DocumentId = @documentId AND d.IsActive = 1`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

/** Everything needed to serve the file, and nothing that would be sent with it. */
export interface StoredFileLocation {
  documentId: number
  employeeId: number
  originalFilePath: string | null
  processedFilePath: string | null
  originalFileName: string | null
  mimeType: string | null
  documentName: string
  employeeCode: string
}

export async function findStoredFile(documentId: number): Promise<StoredFileLocation | null> {
  const request = await createRequest()
  const result = await request.input('documentId', sql.Int, documentId).query<{
    DocumentId: number
    EmployeeId: number
    OriginalFilePath: string | null
    ProcessedFilePath: string | null
    OriginalFileName: string | null
    MimeType: string | null
    DocumentName: string
    EmployeeCode: string
  }>(`
      SELECT d.DocumentId, d.EmployeeId, d.OriginalFilePath, d.ProcessedFilePath,
             d.OriginalFileName, d.MimeType, dt.DocumentName, e.EmployeeCode
      FROM   dbo.EmployeeDocuments AS d
      INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
      INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
      WHERE  d.DocumentId = @documentId AND d.IsActive = 1`)

  const row = result.recordset[0]
  if (!row) return null

  return {
    documentId: row.DocumentId,
    employeeId: row.EmployeeId,
    originalFilePath: row.OriginalFilePath,
    processedFilePath: row.ProcessedFilePath,
    originalFileName: row.OriginalFileName,
    mimeType: row.MimeType,
    documentName: row.DocumentName,
    employeeCode: row.EmployeeCode,
  }
}

export interface AttachFileInput {
  documentId: number
  originalFileName: string
  storedFileName: string
  originalFilePath: string
  fileSizeBytes: number
  mimeType: string
  sha256: Buffer
  status: DocumentStatus
  signatureStatus: SignatureStatus
  uploadedBy: number
  /** Null clears the deadline: a document already held on paper is not awaited. */
  dueDate: string | null
  clearDueDate: boolean
  verifiedBy: number | null
}

/**
 * Points a checklist row at a newly stored file.
 *
 * The row is updated rather than replaced, so DocumentId - which signature
 * placements and the audit trail refer to - stays stable across a replacement.
 * The previous file is deliberately left on disk (standing assumption 3): only
 * the current one is ever served, but the old one is still there if a
 * replacement turns out to have been a mistake.
 *
 * RejectionReason is cleared, because a new file is exactly the answer to a
 * rejection, and CK_EmpDocs_RejectionReason would otherwise leave a stale
 * reason attached to an accepted document.
 */
export async function attachFile(input: AttachFileInput): Promise<void> {
  const request = await createRequest()
  await request
    .input('documentId', sql.Int, input.documentId)
    .input('originalFileName', sql.NVarChar(260), input.originalFileName)
    .input('storedFileName', sql.VarChar(100), input.storedFileName)
    .input('originalFilePath', sql.NVarChar(500), input.originalFilePath)
    .input('fileSizeBytes', sql.BigInt, input.fileSizeBytes)
    .input('mimeType', sql.VarChar(100), input.mimeType)
    .input('sha256', sql.VarBinary(32), input.sha256)
    .input('status', sql.VarChar(20), input.status)
    .input('signatureStatus', sql.VarChar(20), input.signatureStatus)
    .input('uploadedBy', sql.Int, input.uploadedBy)
    .input('verifiedBy', sql.Int, input.verifiedBy)
    .input('dueDate', sql.Date, input.dueDate === null ? null : parseDateOnly(input.dueDate))
    .input('clearDueDate', sql.Bit, input.clearDueDate).query(`
      UPDATE dbo.EmployeeDocuments
      SET    OriginalFileName = @originalFileName,
             StoredFileName   = @storedFileName,
             OriginalFilePath = @originalFilePath,
             ProcessedFilePath = NULL,
             FileSizeBytes    = @fileSizeBytes,
             MimeType         = @mimeType,
             Sha256           = @sha256,
             Status           = @status,
             SignatureStatus  = @signatureStatus,
             RejectionReason  = NULL,
             UploadedBy       = @uploadedBy,
             UploadedAt       = SYSUTCDATETIME(),
             VerifiedBy       = @verifiedBy,
             VerifiedAt       = CASE WHEN @verifiedBy IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
             DueDate          = CASE WHEN @clearDueDate = 1 THEN NULL ELSE @dueDate END,
             UpdatedAt        = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1`)
}

/**
 * Moves a document to a new status.
 *
 * The current status is part of the WHERE clause, so two people verifying the
 * same document at the same moment cannot both succeed: the second update
 * matches no row, and the service reports the conflict instead of quietly
 * overwriting the first decision.
 */
export async function setStatus(
  documentId: number,
  fromStatus: DocumentStatus,
  toStatus: DocumentStatus,
  actorId: number,
  rejectionReason: string | null,
): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('fromStatus', sql.VarChar(20), fromStatus)
    .input('toStatus', sql.VarChar(20), toStatus)
    .input('actorId', sql.Int, actorId)
    .input('rejectionReason', sql.NVarChar(500), rejectionReason)
    .input('verified', sql.Bit, toStatus === DOCUMENT_STATUS.VERIFIED).query(`
      UPDATE dbo.EmployeeDocuments
      SET    Status = @toStatus,
             RejectionReason = @rejectionReason,
             VerifiedBy = CASE WHEN @verified = 1 THEN @actorId ELSE VerifiedBy END,
             VerifiedAt = CASE WHEN @verified = 1 THEN SYSUTCDATETIME() ELSE VerifiedAt END,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1 AND Status = @fromStatus`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/** Sets or clears a single document's deadline, overriding the type's default. */
export async function setDueDate(documentId: number, dueDate: string | null): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('dueDate', sql.Date, dueDate === null ? null : parseDateOnly(dueDate)).query(`
      UPDATE dbo.EmployeeDocuments
      SET    DueDate = @dueDate,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * Records the signed copy, and the signature state that goes with it.
 *
 * Both move together on purpose: a processed file with a signature status of
 * ReviewRequired, or an 'Added' status with no processed file, are each a
 * document that reads as one thing and is another.
 */
export async function setProcessedFile(
  documentId: number,
  processedFilePath: string | null,
  signatureStatus: SignatureStatus,
): Promise<void> {
  const request = await createRequest()
  await request
    .input('documentId', sql.Int, documentId)
    .input('processedFilePath', sql.NVarChar(500), processedFilePath)
    .input('signatureStatus', sql.VarChar(20), signatureStatus).query(`
      UPDATE dbo.EmployeeDocuments
      SET    ProcessedFilePath = @processedFilePath,
             SignatureStatus = @signatureStatus,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1`)
}

/**
 * Moves the signature state on its own, for the paths that change nothing else
 * - skipping, or sending a document back for review.
 *
 * The current value is in the WHERE clause, so two people acting on the same
 * document cannot both succeed.
 */
export async function setSignatureStatus(
  documentId: number,
  fromStatus: SignatureStatus,
  toStatus: SignatureStatus,
): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('fromStatus', sql.VarChar(20), fromStatus)
    .input('toStatus', sql.VarChar(20), toStatus).query(`
      UPDATE dbo.EmployeeDocuments
      SET    SignatureStatus = @toStatus,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1 AND SignatureStatus = @fromStatus`)

  return (result.rowsAffected[0] ?? 0) > 0
}
