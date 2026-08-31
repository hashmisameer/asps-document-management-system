import { ALL_ROLES, type Role } from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.Sessions access.
 *
 * Lookups are by the SHA-256 of the token, which is what the table stores; the
 * token itself is never written anywhere. The lookup joins Users and Roles in
 * one round trip, because it runs on every authenticated request and a second
 * query per request would be a per-request cost for no benefit.
 */

export interface SessionRecord {
  sessionId: number
  userId: number
  issuedAt: Date
  lastSeenAt: Date
  expiresAt: Date
  absoluteExpiry: Date
  revokedAt: Date | null
  /** Joined from dbo.Users, so an authenticated request needs one query. */
  username: string
  fullName: string
  role: Role
  isActive: boolean
  mustChangePassword: boolean
}

interface SessionRow {
  SessionId: number
  UserId: number
  IssuedAt: Date
  LastSeenAt: Date
  ExpiresAt: Date
  AbsoluteExpiry: Date
  RevokedAt: Date | null
  Username: string
  FullName: string
  RoleName: string
  IsActive: boolean
  MustChangePassword: boolean
}

function toRecord(row: SessionRow): SessionRecord {
  if (!(ALL_ROLES as readonly string[]).includes(row.RoleName)) {
    throw new Error(
      `User ${row.UserId} has a role that is not in ROLE_PERMISSIONS. Check dbo.Roles.`,
    )
  }

  return {
    sessionId: row.SessionId,
    userId: row.UserId,
    issuedAt: row.IssuedAt,
    lastSeenAt: row.LastSeenAt,
    expiresAt: row.ExpiresAt,
    absoluteExpiry: row.AbsoluteExpiry,
    revokedAt: row.RevokedAt,
    username: row.Username,
    fullName: row.FullName,
    role: row.RoleName as Role,
    isActive: row.IsActive,
    mustChangePassword: row.MustChangePassword,
  }
}

export interface CreateSessionInput {
  userId: number
  tokenHash: Buffer
  expiresAt: Date
  absoluteExpiry: Date
  ipAddress: string | null
  userAgent: string | null
}

export async function create(input: CreateSessionInput): Promise<number> {
  const request = await createRequest()
  const result = await request
    .input('userId', sql.Int, input.userId)
    .input('tokenHash', sql.VarBinary(32), input.tokenHash)
    .input('expiresAt', sql.DateTime2(3), input.expiresAt)
    .input('absoluteExpiry', sql.DateTime2(3), input.absoluteExpiry)
    .input('ipAddress', sql.VarChar(45), input.ipAddress)
    // A crafted user agent is stored, not executed, but it is truncated to the
    // column width here so an over-long one is not a failed login.
    .input('userAgent', sql.NVarChar(300), input.userAgent?.slice(0, 300) ?? null)
    .query<{ SessionId: number }>(`
      INSERT INTO dbo.Sessions (UserId, TokenHash, ExpiresAt, AbsoluteExpiry, IpAddress, UserAgent)
      OUTPUT INSERTED.SessionId
      VALUES (@userId, @tokenHash, @expiresAt, @absoluteExpiry, @ipAddress, @userAgent)`)

  const row = result.recordset[0]
  if (!row) throw new Error('Session insert returned no SessionId')
  return row.SessionId
}

/**
 * Finds a session by token hash.
 *
 * Expiry is filtered in SQL against the SERVER's clock, so an expired session
 * never reaches the application; services/session.service.ts checks the same
 * rules again in Node. Two clocks, one answer - and a row hand-edited in the
 * database still cannot resurrect a dead session.
 */
export async function findByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null> {
  const request = await createRequest()
  const result = await request.input('tokenHash', sql.VarBinary(32), tokenHash).query<SessionRow>(`
      SELECT  s.SessionId, s.UserId, s.IssuedAt, s.LastSeenAt, s.ExpiresAt,
              s.AbsoluteExpiry, s.RevokedAt,
              u.Username, u.FullName, r.RoleName, u.IsActive, u.MustChangePassword
      FROM    dbo.Sessions AS s
      INNER JOIN dbo.Users AS u ON u.UserId = s.UserId
      INNER JOIN dbo.Roles AS r ON r.RoleId = u.RoleId
      WHERE   s.TokenHash = @tokenHash
        AND   s.RevokedAt IS NULL
        AND   s.ExpiresAt > SYSUTCDATETIME()
        AND   s.AbsoluteExpiry > SYSUTCDATETIME()`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

/** Extends the idle expiry of an active session. See SESSION_TOUCH_INTERVAL_MS. */
export async function touch(sessionId: number, expiresAt: Date): Promise<void> {
  const request = await createRequest()
  await request
    .input('sessionId', sql.BigInt, sessionId)
    .input('expiresAt', sql.DateTime2(3), expiresAt).query(`
      UPDATE dbo.Sessions
      SET    LastSeenAt = SYSUTCDATETIME(),
             ExpiresAt = @expiresAt
      WHERE  SessionId = @sessionId
        AND  RevokedAt IS NULL`)
}

export async function revoke(sessionId: number): Promise<void> {
  const request = await createRequest()
  await request.input('sessionId', sql.BigInt, sessionId).query(`
      UPDATE dbo.Sessions
      SET    RevokedAt = SYSUTCDATETIME()
      WHERE  SessionId = @sessionId
        AND  RevokedAt IS NULL`)
}

/**
 * Revokes every live session for a user.
 *
 * Called on a password change: whoever knew the old password - including
 * whoever the change is a response to - loses every session immediately.
 */
export async function revokeAllForUser(
  userId: number,
  transaction?: sql.Transaction,
): Promise<number> {
  const request = await createRequest(transaction)
  const result = await request.input('userId', sql.Int, userId).query(`
      UPDATE dbo.Sessions
      SET    RevokedAt = SYSUTCDATETIME()
      WHERE  UserId = @userId
        AND  RevokedAt IS NULL`)

  return result.rowsAffected[0] ?? 0
}

/**
 * Removes sessions that expired long enough ago to be of no forensic use.
 *
 * Nothing calls this on a timer yet: the table grows by a handful of rows a day
 * for five users, so a scheduled job would be machinery without a purpose. It
 * exists so housekeeping is a call, not a hand-written DELETE, when it is
 * wanted.
 */
export async function deleteExpiredBefore(cutoff: Date): Promise<number> {
  const request = await createRequest()
  const result = await request.input('cutoff', sql.DateTime2(3), cutoff).query(`
      DELETE FROM dbo.Sessions
      WHERE  AbsoluteExpiry < @cutoff`)

  return result.rowsAffected[0] ?? 0
}
