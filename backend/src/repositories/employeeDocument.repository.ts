import {
  DEADLINE_UNITS,
  DEFAULT_DUE_SOON_THRESHOLD_DAYS,
  DOCUMENT_STATUS,
  SIGNATURE_STATUS,
  formatDateOnly,
  parseDateOnly,
  type DocumentIdentityCheck,
  type DeadlineUnit,
  type DocumentListQuery,
  type DocumentStatus,
  type EmployeeDocument,
  type FieldCheck,
  type SignatureStatus,
  type TextSource,
} from '@asps-dms/shared'
import { todayDateOnly } from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'
import { escapeLike } from '../utils/sqlLike.js'
import { COUNTABLE_DOCUMENT } from './employeeScope.js'
import { logger } from '../utils/logger.js'

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

/**
 * A checklist row as stored: everything except the derived deadline fields.
 *
 * Plus one thing the row itself cannot say - whether the employee it belongs to
 * has gone. It is read with the row so that ANY caller deriving a deadline from
 * a record has the fact in hand: a document read on its own used to come back
 * 'Overdue by 200 days' for somebody who left last March, because only the
 * screen that listed a whole checklist knew to say otherwise.
 *
 * Not part of the API shape - it is stripped when the deadline is derived.
 */
export type EmployeeDocumentRecord = Omit<EmployeeDocument, 'deadlineState' | 'daysRemaining'> & {
  employeeHasLeft: boolean
}

interface EmployeeDocumentRow {
  DocumentId: number
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  LastWorkingDate: Date | null
  DeadlineUnit: string | null
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
  NotRequiredAt: Date | null
  NotRequiredByName: string | null
  DueDate: Date | null
  UploadedByName: string | null
  UploadedAt: Date | null
  VerifiedByName: string | null
  VerifiedAt: Date | null
  RejectionReason: string | null
  IdentityCheckStatus: string | null
  IdentityCheckSource: string | null
  IdentityCheckDetail: string | null
  IdentityCheckedAt: Date | null
  IdentityOverrideByName: string | null
  IdentityOverrideReason: string | null
  CreatedAt: Date
  UpdatedAt: Date
}

const SELECT_EMPLOYEE_DOCUMENT = `
    SELECT  d.DocumentId, d.EmployeeId, e.EmployeeCode, e.EmployeeName,
            e.LastWorkingDate, dt.DeadlineUnit,
            d.DocumentTypeId, dt.DocumentName, dt.IsMandatory, dt.RequiresSignature,
            d.OriginalFileName, d.FileSizeBytes, d.MimeType, d.PageCount,
            d.ProcessedFilePath, d.Status, d.SignatureStatus, d.DueDate,
            d.NotRequiredAt, nr.FullName AS NotRequiredByName,
            up.FullName AS UploadedByName, d.UploadedAt,
            vf.FullName AS VerifiedByName, d.VerifiedAt,
            d.RejectionReason,
            d.IdentityCheckStatus, d.IdentityCheckSource, d.IdentityCheckDetail,
            d.IdentityCheckedAt, ov.FullName AS IdentityOverrideByName,
            d.IdentityOverrideReason,
            d.CreatedAt, d.UpdatedAt
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
    LEFT JOIN dbo.Users AS up ON up.UserId = d.UploadedBy
    LEFT JOIN dbo.Users AS nr ON nr.UserId = d.NotRequiredBy
    LEFT JOIN dbo.Users AS vf ON vf.UserId = d.VerifiedBy
    LEFT JOIN dbo.Users AS ov ON ov.UserId = d.IdentityOverrideBy`

/** A deadline unit as stored, or none. Anything unrecognised reads as none. */
function toDeadlineUnit(value: string | null): DeadlineUnit | null {
  return value === DEADLINE_UNITS.DAY || value === DEADLINE_UNITS.MONTH ? value : null
}

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

/**
 * The identity check as it was recorded, or null for a document that predates
 * the check or whose type is not checked at all.
 *
 * The per-field detail is JSON in an NVARCHAR(MAX) column, because SQL Server
 * 2014 has no JSON type and nothing ever queries inside it - it is read whole,
 * with the row it belongs to. Unparseable JSON is reported as no detail rather
 * than thrown: a document that cannot be opened because a column written months
 * ago is malformed would be a far worse failure than a missing explanation.
 */
function toIdentityCheck(row: EmployeeDocumentRow): DocumentIdentityCheck | null {
  const status = row.IdentityCheckStatus
  if (
    status !== 'Passed' &&
    status !== 'Overridden' &&
    status !== 'NotChecked' &&
    status !== 'Checking' &&
    status !== 'Failed'
  ) {
    return null
  }

  let checks: FieldCheck[] = []
  if (row.IdentityCheckDetail !== null) {
    try {
      const parsed: unknown = JSON.parse(row.IdentityCheckDetail)
      if (Array.isArray(parsed)) checks = parsed as FieldCheck[]
    } catch (error) {
      logger.warn(
        { err: error, documentId: row.DocumentId },
        'Could not parse IdentityCheckDetail; reporting the check without its per-field detail',
      )
    }
  }

  return {
    status,
    source: (row.IdentityCheckSource as TextSource | null) ?? null,
    checks,
    checkedAt: row.IdentityCheckedAt?.toISOString() ?? null,
    overriddenByName: row.IdentityOverrideByName,
    overrideReason: row.IdentityOverrideReason,
    // A refusal now has somewhere to live, because the document is stored before
    // it is judged. The sentence is kept with the row rather than rebuilt on the
    // screen, so what HR reads is what the check actually said at the time.
    failureReason: status === 'Failed' ? row.IdentityOverrideReason : null,
  }
}

function toRecord(row: EmployeeDocumentRow): EmployeeDocumentRecord {
  return {
    documentId: row.DocumentId,
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    // Compared as calendar days, the same way EFFECTIVE_LEFT compares them in
    // SQL: somebody working their notice has not gone yet.
    employeeHasLeft:
      row.LastWorkingDate !== null && formatDateOnly(row.LastWorkingDate) < todayDateOnly(),
    // The TYPE's unit, so the screen can say 'Due in 5 months' for the one
    // document counted that way. The due date on the row is untouched by it.
    deadlineUnit: toDeadlineUnit(row.DeadlineUnit),
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
    notRequiredAt: row.NotRequiredAt?.toISOString() ?? null,
    notRequiredByName: row.NotRequiredByName,
    dueDate: row.DueDate === null ? null : formatDateOnly(row.DueDate),
    uploadedByName: row.UploadedByName,
    uploadedAt: row.UploadedAt?.toISOString() ?? null,
    verifiedByName: row.VerifiedByName,
    verifiedAt: row.VerifiedAt?.toISOString() ?? null,
    rejectionReason: row.RejectionReason,
    identityCheck: toIdentityCheck(row),
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
  /** Identifies the exact file, so a verdict cannot land on a later replacement. */
  storedFileName: string | null
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
    StoredFileName: string | null
    OriginalFilePath: string | null
    ProcessedFilePath: string | null
    OriginalFileName: string | null
    MimeType: string | null
    DocumentName: string
    EmployeeCode: string
  }>(`
      SELECT d.DocumentId, d.EmployeeId, d.StoredFileName, d.OriginalFilePath, d.ProcessedFilePath,
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
    storedFileName: row.StoredFileName,
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
  /**
   * What reading the file found, and any override of a refusal.
   *
   * Written in the same statement that points the row at the file, so a
   * document and the check that let it in can never disagree: there is no
   * moment where the row says a file is attached and says nothing about
   * whether it was checked.
   */
  identity: AttachIdentityCheck
}

export interface AttachIdentityCheck {
  status: 'Passed' | 'Overridden' | 'NotChecked' | 'Checking' | 'Failed'
  source: TextSource | null
  /** Per-field outcomes, serialised to JSON by the caller's shape, not the text read. */
  checks: FieldCheck[]
  overrideBy: number | null
  overrideReason: string | null
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
    .input('clearDueDate', sql.Bit, input.clearDueDate)
    .input('identityStatus', sql.VarChar(20), input.identity.status)
    .input('identitySource', sql.VarChar(10), input.identity.source)
    .input(
      'identityDetail',
      sql.NVarChar(sql.MAX),
      input.identity.checks.length === 0 ? null : JSON.stringify(input.identity.checks),
    )
    .input('identityOverrideBy', sql.Int, input.identity.overrideBy)
    .input('identityOverrideReason', sql.NVarChar(500), input.identity.overrideReason)
    .query(`
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
             IdentityCheckStatus    = @identityStatus,
             IdentityCheckSource    = @identitySource,
             IdentityCheckDetail    = @identityDetail,
             IdentityCheckedAt      = SYSUTCDATETIME(),
             IdentityOverrideBy     = @identityOverrideBy,
             IdentityOverrideReason = @identityOverrideReason,
             UpdatedAt        = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1`)
}

/**
 * Records the result of a check that ran AFTER the file was stored.
 *
 * The reading no longer happens inside the upload request - it takes up to a
 * minute and whoever pressed Upload was made to wait for all of it - so the row
 * is written twice: once saying 'Checking' when the file lands, and once here
 * when the answer arrives.
 *
 * Guarded on the file still being the one that was read. A replacement during
 * those seconds would otherwise have last week's verdict stamped onto this
 * week's document, which is precisely the mistake this whole check exists to
 * prevent.
 */
export async function recordIdentityCheck(input: {
  documentId: number
  storedFileName: string
  status: 'Passed' | 'Overridden' | 'Failed' | 'NotChecked'
  source: TextSource | null
  checks: FieldCheck[]
  /** The refusal sentence for 'Failed', or the person's words for 'Overridden'. */
  reason: string | null
  overrideBy: number | null
}): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, input.documentId)
    .input('storedFileName', sql.NVarChar(260), input.storedFileName)
    .input('status', sql.VarChar(20), input.status)
    .input('source', sql.VarChar(10), input.source)
    .input('detail', sql.NVarChar(sql.MAX), JSON.stringify(input.checks))
    .input('reason', sql.NVarChar(500), input.reason)
    .input('overrideBy', sql.Int, input.overrideBy).query(`
      UPDATE dbo.EmployeeDocuments
      SET    IdentityCheckStatus    = @status,
             IdentityCheckSource    = @source,
             IdentityCheckDetail    = @detail,
             IdentityCheckedAt      = SYSUTCDATETIME(),
             IdentityOverrideBy     = @overrideBy,
             IdentityOverrideReason = @reason,
             UpdatedAt              = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId
        AND  IsActive = 1
        AND  StoredFileName = @storedFileName`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * Documents left mid-check when the process stopped.
 *
 * A reading that was interrupted leaves a row saying 'Checking' with nothing
 * coming to change it. Read at startup so those can be picked up again, rather
 * than sitting on somebody's screen for ever.
 */
export async function findUnfinishedChecks(): Promise<
  { documentId: number; storedFileName: string }[]
> {
  const request = await createRequest()
  const result = await request.query<{ DocumentId: number; StoredFileName: string }>(`
      SELECT DocumentId, StoredFileName
      FROM   dbo.EmployeeDocuments
      WHERE  IsActive = 1
        AND  IdentityCheckStatus = 'Checking'
        AND  StoredFileName IS NOT NULL`)

  return result.recordset.map((row) => ({
    documentId: row.DocumentId,
    storedFileName: row.StoredFileName,
  }))
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

/**
 * Marks a document as not required of this employee, or puts it back.
 *
 * ONE function for both directions, because they are the same write with the
 * two columns set or cleared together - the CHECK constraint on the table
 * insists on that pairing, and so does anybody trying to answer 'who decided
 * this' later.
 *
 * `NotRequiredAt IS NULL` is in the WHERE clause, matched against what the
 * caller believed: two people pressing the button at the same moment cannot
 * both succeed, and the second is told rather than silently overwriting the
 * first. The same guard every other write in this file uses.
 *
 * THE DUE DATE IS NOT TOUCHED. Undoing this returns the document to the
 * deadline it always had rather than to one invented on the way back.
 */
export async function setNotRequired(
  documentId: number,
  notRequired: boolean,
  actorId: number,
): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('actorId', sql.Int, actorId)
    .input('notRequired', sql.Bit, notRequired).query(`
      UPDATE dbo.EmployeeDocuments
      SET    NotRequiredAt = CASE WHEN @notRequired = 1 THEN SYSUTCDATETIME() ELSE NULL END,
             NotRequiredBy = CASE WHEN @notRequired = 1 THEN @actorId ELSE NULL END,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId
        AND  IsActive = 1
        AND  (@notRequired = 1 AND NotRequiredAt IS NULL
              OR @notRequired = 0 AND NotRequiredAt IS NOT NULL)`)

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

/**
 * Takes the file off a checklist row, returning it to Pending.
 *
 * For a document uploaded against the wrong employee or the wrong row - the
 * mistake that has no other remedy now that there is no rejection step.
 *
 * The FILE ITSELF is left on disk, exactly as a replaced one is. Only the
 * current file is ever served, and the previous bytes are there if removing it
 * turns out to have been the mistake rather than the upload.
 *
 * Everything that described that file goes with it: its identity check, its
 * signature work and its processed copy. A placement describes a page in a file
 * that is no longer there, and an identity check that a file passed says
 * nothing about the row once the file is gone.
 *
 * The due date is untouched. It belongs to the checklist row - what is expected
 * of this employee by when - and not to whichever file happened to satisfy it.
 */
/**
 * Takes a refused file back off the row, and says why it is not there.
 *
 * Not `clearFile`, which wipes the identity columns along with everything else -
 * correct when a person removes a document on purpose, wrong here. This leaves
 * the row Pending as if the upload had not happened, EXCEPT that it still
 * carries the refusal, because a document that silently fails to appear is the
 * most confusing outcome available.
 *
 * Guarded on the stored file, so a replacement uploaded in the seconds since is
 * never the one removed.
 */
export async function clearRefusedFile(
  documentId: number,
  storedFileName: string,
  reason: string,
): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('storedFileName', sql.VarChar(100), storedFileName)
    .input('status', sql.VarChar(20), DOCUMENT_STATUS.PENDING)
    .input('signatureStatus', sql.VarChar(20), SIGNATURE_STATUS.NOT_REQUIRED)
    .input('reason', sql.NVarChar(500), reason).query(`
      UPDATE dbo.EmployeeDocuments
      SET    OriginalFileName  = NULL,
             StoredFileName    = NULL,
             OriginalFilePath  = NULL,
             ProcessedFilePath = NULL,
             FileSizeBytes     = NULL,
             MimeType          = NULL,
             Sha256            = NULL,
             PageCount         = NULL,
             Status            = @status,
             SignatureStatus   = @signatureStatus,
             RejectionReason   = NULL,
             UploadedBy        = NULL,
             UploadedAt        = NULL,
             VerifiedBy        = NULL,
             VerifiedAt        = NULL,
             IdentityCheckStatus    = 'Failed',
             IdentityCheckedAt      = SYSUTCDATETIME(),
             IdentityOverrideBy     = NULL,
             IdentityOverrideReason = @reason,
             UpdatedAt         = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId
        AND  IsActive = 1
        AND  StoredFileName = @storedFileName`)

  return (result.rowsAffected[0] ?? 0) > 0
}

export async function clearFile(documentId: number, signatureStatus: string): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('documentId', sql.Int, documentId)
    .input('status', sql.VarChar(20), DOCUMENT_STATUS.PENDING)
    .input('signatureStatus', sql.VarChar(20), signatureStatus).query(`
      UPDATE dbo.EmployeeDocuments
      SET    OriginalFileName = NULL,
             StoredFileName   = NULL,
             OriginalFilePath = NULL,
             ProcessedFilePath = NULL,
             FileSizeBytes    = NULL,
             MimeType         = NULL,
             Sha256           = NULL,
             PageCount        = NULL,
             Status           = @status,
             SignatureStatus  = @signatureStatus,
             RejectionReason  = NULL,
             UploadedBy       = NULL,
             UploadedAt       = NULL,
             VerifiedBy       = NULL,
             VerifiedAt       = NULL,
             IdentityCheckStatus    = NULL,
             IdentityCheckSource    = NULL,
             IdentityCheckDetail    = NULL,
             IdentityCheckedAt      = NULL,
             IdentityOverrideBy     = NULL,
             IdentityOverrideReason = NULL,
             UpdatedAt        = SYSUTCDATETIME()
      WHERE  DocumentId = @documentId AND IsActive = 1 AND OriginalFilePath IS NOT NULL`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * One line of the documents list: who owes what.
 *
 * Lighter than EmployeeDocumentRecord on purpose. This is read a page at a time
 * across every employee in the company, and the identity-check detail on the
 * full record is of no use in a table - it is read on the employee's own page,
 * where it belongs.
 */
export interface DocumentListRecord {
  documentId: number
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  documentTypeId: number
  documentName: string
  isMandatory: boolean
  status: DocumentStatus
  /** A file is attached - whatever review it is at. */
  hasFile: boolean
  dueDate: string | null
  /** How the deadline is counted back on screen: days, or months. */
  deadlineUnit: DeadlineUnit | null
  uploadedAt: string | null
}

/**
 * The predicates behind each state a documents list can be asked for.
 *
 * THESE ARE THE DASHBOARD'S OWN PREDICATES, word for word - see
 * dashboard.repository.ts. The tiles count rows with them and this list selects
 * rows with them, which is the only way a tile that says 57 can open a list of
 * 57. Anything cleverer here would be a second definition to keep in step.
 *
 * 'received' is 'a file arrived', not 'a file was accepted': a rejected
 * document has still come in and is still on the record.
 */
const DOCUMENT_STATE_SQL: Readonly<Record<Exclude<DocumentListQuery['state'], 'all'>, string>> = {
  received: 'd.OriginalFilePath IS NOT NULL',
  pending: 'd.OriginalFilePath IS NULL',
  overdue: 'd.OriginalFilePath IS NULL AND d.DueDate IS NOT NULL AND d.DueDate < @today',
  dueSoon:
    'd.OriginalFilePath IS NULL AND d.DueDate IS NOT NULL' +
    ' AND d.DueDate >= @today AND d.DueDate <= DATEADD(DAY, @dueSoonDays, @today)',
}

const DOCUMENT_LIST_SORT_COLUMNS: Readonly<Record<DocumentListQuery['sortBy'], string>> = {
  employeeName: 'e.EmployeeName',
  employeeCode: 'e.EmployeeCode',
  documentName: 'dt.DocumentName',
  dueDate: 'd.DueDate',
  department: 'e.Department',
}

interface DocumentListRow {
  DocumentId: number
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  Department: string | null
  Designation: string | null
  DocumentTypeId: number
  DocumentName: string
  IsMandatory: boolean
  Status: string
  DeadlineUnit: string | null
  HasFile: number
  DueDate: Date | null
  UploadedAt: Date | null
  Total: number
}

/**
 * Every checklist row in the company, filtered and paged.
 *
 * Counted against ACTIVE employees who have not left, exactly as the dashboard
 * counts them: paperwork nobody can bring in is not outstanding, it is over.
 */
export async function listAll(
  query: DocumentListQuery,
): Promise<{ rows: DocumentListRecord[]; total: number }> {
  const request = await createRequest()
  request
    .input('today', sql.Date, parseDateOnly(todayDateOnly()))
    .input('dueSoonDays', sql.Int, DEFAULT_DUE_SOON_THRESHOLD_DAYS)
    .input('offset', sql.Int, (query.page - 1) * query.pageSize)
    .input('pageSize', sql.Int, query.pageSize)

  // Nobody who has left, and nothing on an archived record: the same scope
  // every count on the dashboard uses, which is what makes a tile and this
  // list agree on the number.
  const conditions = [COUNTABLE_DOCUMENT]

  if (query.state !== 'all') conditions.push(DOCUMENT_STATE_SQL[query.state])

  if (query.documentTypeId) {
    conditions.push('d.DocumentTypeId = @documentTypeId')
    request.input('documentTypeId', sql.Int, query.documentTypeId)
  }
  if (query.employeeId) {
    conditions.push('d.EmployeeId = @employeeId')
    request.input('employeeId', sql.Int, query.employeeId)
  }
  if (query.department) {
    conditions.push('e.Department = @department')
    request.input('department', sql.NVarChar(100), query.department)
  }
  if (query.mandatory) {
    conditions.push(query.mandatory === 'mandatory' ? 'dt.IsMandatory = 1' : 'dt.IsMandatory = 0')
  }
  if (query.search) {
    conditions.push(
      "(e.EmployeeName LIKE @search ESCAPE '\\' OR e.EmployeeCode LIKE @search ESCAPE '\\'" +
        " OR dt.DocumentName LIKE @search ESCAPE '\\')",
    )
    request.input('search', sql.NVarChar(210), `%${escapeLike(query.search)}%`)
  }

  // Literals only: every condition above is a fixed string naming a parameter,
  // never a caller's value.
  const WHERE_CLAUSE = conditions.join(' AND ')
  const DIRECTION = query.sortDir === 'desc' ? 'DESC' : 'ASC'
  // DocumentId breaks ties so paging is stable: without it, two rows that sort
  // equally can appear on two pages, or on none.
  const ORDER_BY_CLAUSE = `${DOCUMENT_LIST_SORT_COLUMNS[query.sortBy]} ${DIRECTION}, d.DocumentId ASC`

  const result = await request.query<DocumentListRow>(`
    SELECT  d.DocumentId, d.EmployeeId, e.EmployeeCode, e.EmployeeName,
            e.Department, e.Designation,
            d.DocumentTypeId, dt.DocumentName, dt.IsMandatory,
            d.Status, dt.DeadlineUnit,
            CASE WHEN d.OriginalFilePath IS NULL THEN 0 ELSE 1 END AS HasFile,
            d.DueDate, d.UploadedAt,
            COUNT(*) OVER () AS Total
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
    WHERE   ${WHERE_CLAUSE}
    ORDER BY ${ORDER_BY_CLAUSE}
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `)

  const rows = result.recordset.map((row) => ({
    documentId: row.DocumentId,
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    department: row.Department,
    designation: row.Designation,
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    isMandatory: row.IsMandatory,
    status: row.Status as DocumentStatus,
    deadlineUnit: toDeadlineUnit(row.DeadlineUnit),
    hasFile: row.HasFile === 1,
    dueDate: row.DueDate === null ? null : formatDateOnly(row.DueDate),
    uploadedAt: row.UploadedAt === null ? null : row.UploadedAt.toISOString(),
  }))

  return { rows, total: result.recordset[0]?.Total ?? 0 }
}