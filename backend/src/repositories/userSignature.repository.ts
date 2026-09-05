import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.UserSignatures access.
 *
 * The authorising signature: the mark an HR or Admin user puts on a document to
 * say they signed it off. One active row per user, enrolled once on the
 * signature pad and reused, exactly as an employee's is (Section 24).
 *
 * UX_UserSig_User_Active - a filtered unique index on IsActive = 1 - is what
 * guarantees there is only ever one current signature per user; the deactivate
 * and the insert below run in one transaction so the two never briefly coexist
 * and a user is never briefly left with none.
 *
 * Replacing deactivates the previous row rather than deleting it, so which
 * image a document was signed with at the time it was issued stays answerable.
 */

export type CaptureMethod = 'Drawn' | 'Uploaded'

export interface UserSignatureRecord {
  userSignatureId: number
  userId: number
  relativePath: string
  mimeType: string
  fileSizeBytes: number | null
  widthPx: number | null
  heightPx: number | null
  captureMethod: CaptureMethod
  createdAt: string
  updatedAt: string
}

interface UserSignatureRow {
  UserSignatureId: number
  UserId: number
  FilePath: string
  MimeType: string
  FileSizeBytes: string | number | null
  WidthPx: number | null
  HeightPx: number | null
  CaptureMethod: string
  CreatedAt: Date
  UpdatedAt: Date
}

function toRecord(row: UserSignatureRow): UserSignatureRecord {
  return {
    userSignatureId: row.UserSignatureId,
    userId: row.UserId,
    relativePath: row.FilePath,
    mimeType: row.MimeType,
    fileSizeBytes: row.FileSizeBytes === null ? null : Number(row.FileSizeBytes),
    widthPx: row.WidthPx,
    heightPx: row.HeightPx,
    captureMethod: row.CaptureMethod as CaptureMethod,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

export async function findActiveByUser(userId: number): Promise<UserSignatureRecord | null> {
  const request = await createRequest()
  const result = await request.input('userId', sql.Int, userId).query<UserSignatureRow>(`
      SELECT TOP (1) us.UserSignatureId, us.UserId, us.FilePath, us.MimeType,
             us.FileSizeBytes, us.WidthPx, us.HeightPx, us.CaptureMethod,
             us.CreatedAt, us.UpdatedAt
      FROM   dbo.UserSignatures AS us
      WHERE  us.UserId = @userId AND us.IsActive = 1`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

export interface CreateUserSignatureInput {
  userId: number
  storedFileName: string
  relativePath: string
  mimeType: string
  fileSizeBytes: number
  widthPx: number
  heightPx: number
  captureMethod: CaptureMethod
}

export async function replaceActive(input: CreateUserSignatureInput): Promise<number> {
  const request = await createRequest()
  const result = await request
    .input('userId', sql.Int, input.userId)
    .input('storedFileName', sql.VarChar(100), input.storedFileName)
    .input('filePath', sql.NVarChar(500), input.relativePath)
    .input('mimeType', sql.VarChar(100), input.mimeType)
    .input('fileSizeBytes', sql.BigInt, input.fileSizeBytes)
    .input('widthPx', sql.Int, input.widthPx)
    .input('heightPx', sql.Int, input.heightPx)
    .input('captureMethod', sql.VarChar(20), input.captureMethod)
    .query<{ UserSignatureId: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;

      UPDATE dbo.UserSignatures
      SET    IsActive = 0, UpdatedAt = SYSUTCDATETIME()
      WHERE  UserId = @userId AND IsActive = 1;

      INSERT INTO dbo.UserSignatures
          (UserId, StoredFileName, FilePath, MimeType, FileSizeBytes,
           WidthPx, HeightPx, CaptureMethod)
      OUTPUT INSERTED.UserSignatureId
      VALUES (@userId, @storedFileName, @filePath, @mimeType, @fileSizeBytes,
              @widthPx, @heightPx, @captureMethod);

      COMMIT TRANSACTION;`)

  const row = result.recordset[0]
  if (!row) throw new Error('User signature insert returned no row')
  return row.UserSignatureId
}
