import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.EmployeeSignatures access.
 *
 * A signature is uploaded once per employee and reused on every document they
 * ever sign (Section 24). Replacing one deactivates the previous row rather
 * than deleting it, so which image was applied to a document at the time it was
 * signed stays answerable.
 *
 * UX_EmpSig_Employee_Active - a filtered unique index on IsActive = 1 - is what
 * actually guarantees there is only ever one current signature; the deactivate
 * and the insert below run in one transaction so they never briefly both exist.
 */

export interface EmployeeSignatureRecord {
  employeeSignatureId: number
  employeeId: number
  relativePath: string
  mimeType: string
  originalFileName: string | null
  fileSizeBytes: number | null
  widthPx: number | null
  heightPx: number | null
  uploadedAt: string
  updatedAt: string
}

interface SignatureRow {
  EmployeeSignatureId: number
  EmployeeId: number
  FilePath: string
  MimeType: string
  OriginalFileName: string | null
  FileSizeBytes: string | number | null
  WidthPx: number | null
  HeightPx: number | null
  UploadedAt: Date
  UpdatedAt: Date
}

function toRecord(row: SignatureRow): EmployeeSignatureRecord {
  return {
    employeeSignatureId: row.EmployeeSignatureId,
    employeeId: row.EmployeeId,
    relativePath: row.FilePath,
    mimeType: row.MimeType,
    originalFileName: row.OriginalFileName,
    fileSizeBytes: row.FileSizeBytes === null ? null : Number(row.FileSizeBytes),
    widthPx: row.WidthPx,
    heightPx: row.HeightPx,
    uploadedAt: row.UploadedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

export async function findActiveByEmployee(
  employeeId: number,
): Promise<EmployeeSignatureRecord | null> {
  const request = await createRequest()
  const result = await request.input('employeeId', sql.Int, employeeId).query<SignatureRow>(`
      SELECT TOP (1) es.EmployeeSignatureId, es.EmployeeId, es.FilePath, es.MimeType,
             es.OriginalFileName, es.FileSizeBytes, es.WidthPx, es.HeightPx,
             es.UploadedAt, es.UpdatedAt
      FROM   dbo.EmployeeSignatures AS es
      WHERE  es.EmployeeId = @employeeId AND es.IsActive = 1`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

export interface CreateSignatureInput {
  employeeId: number
  storedFileName: string
  relativePath: string
  originalFileName: string
  mimeType: string
  fileSizeBytes: number
  widthPx: number
  heightPx: number
  uploadedBy: number
}

/**
 * Replaces the employee's signature with a new one.
 *
 * Both statements run in one round trip and one implicit transaction: if the
 * insert failed after the update committed, the employee would be left with no
 * active signature at all, and every document waiting on one would stop.
 */
export async function replaceActive(input: CreateSignatureInput): Promise<number> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, input.employeeId)
    .input('storedFileName', sql.VarChar(100), input.storedFileName)
    .input('filePath', sql.NVarChar(500), input.relativePath)
    .input('originalFileName', sql.NVarChar(260), input.originalFileName)
    .input('mimeType', sql.VarChar(100), input.mimeType)
    .input('fileSizeBytes', sql.BigInt, input.fileSizeBytes)
    .input('widthPx', sql.Int, input.widthPx)
    .input('heightPx', sql.Int, input.heightPx)
    .input('uploadedBy', sql.Int, input.uploadedBy)
    .query<{ EmployeeSignatureId: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;

      UPDATE dbo.EmployeeSignatures
      SET    IsActive = 0, UpdatedAt = SYSUTCDATETIME()
      WHERE  EmployeeId = @employeeId AND IsActive = 1;

      INSERT INTO dbo.EmployeeSignatures
          (EmployeeId, StoredFileName, FilePath, OriginalFileName, MimeType,
           FileSizeBytes, WidthPx, HeightPx, UploadedBy)
      OUTPUT INSERTED.EmployeeSignatureId
      VALUES (@employeeId, @storedFileName, @filePath, @originalFileName, @mimeType,
              @fileSizeBytes, @widthPx, @heightPx, @uploadedBy);

      COMMIT TRANSACTION;`)

  const row = result.recordset[0]
  if (!row) throw new Error('Signature insert returned no row')
  return row.EmployeeSignatureId
}
