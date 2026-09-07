import { ALL_ROLES, type AuthUser, type Role } from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'
import type { PasswordRecord } from '../services/password.service.js'

/**
 * dbo.Users access.
 *
 * Every value reaches SQL Server as a bound parameter - never as text spliced
 * into a query. scripts/check-sql-safety.mjs fails the build on any exception
 * to that, so it cannot quietly stop being true.
 */

export interface UserRecord {
  userId: number
  username: string
  fullName: string
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  password: PasswordRecord
  failedLoginCount: number
  lockedUntil: Date | null
}

interface UserRow {
  UserId: number
  Username: string
  FullName: string
  RoleName: string
  IsActive: boolean
  MustChangePassword: boolean
  PasswordHash: Buffer
  PasswordSalt: Buffer
  PasswordAlgorithm: string
  FailedLoginCount: number
  LockedUntil: Date | null
}

const SELECT_USER = `
    SELECT  u.UserId, u.Username, u.FullName, r.RoleName, u.IsActive,
            u.MustChangePassword, u.PasswordHash, u.PasswordSalt, u.PasswordAlgorithm,
            u.FailedLoginCount, u.LockedUntil
    FROM    dbo.Users AS u
    INNER JOIN dbo.Roles AS r ON r.RoleId = u.RoleId`

function isKnownRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value)
}

function toRecord(row: UserRow): UserRecord {
  if (!isKnownRole(row.RoleName)) {
    // A role in the database that the application has no permission map for is
    // a data problem, not a login problem. Failing loudly beats granting an
    // unknown role whatever the default happens to be.
    throw new Error(
      `User ${row.UserId} has a role that is not in ROLE_PERMISSIONS. Check dbo.Roles.`,
    )
  }

  return {
    userId: row.UserId,
    username: row.Username,
    fullName: row.FullName,
    role: row.RoleName,
    isActive: row.IsActive,
    mustChangePassword: row.MustChangePassword,
    password: {
      hash: row.PasswordHash,
      salt: row.PasswordSalt,
      algorithm: row.PasswordAlgorithm,
    },
    failedLoginCount: row.FailedLoginCount,
    lockedUntil: row.LockedUntil,
  }
}

/** The subset of a user that may cross the API boundary. */
export function toAuthUser(record: UserRecord): AuthUser {
  return {
    userId: record.userId,
    username: record.username,
    fullName: record.fullName,
    role: record.role,
    mustChangePassword: record.mustChangePassword,
  }
}

export async function findByUsername(username: string): Promise<UserRecord | null> {
  const request = await createRequest()
  const result = await request
    .input('username', sql.NVarChar(100), username)
    .query<UserRow>(`${SELECT_USER} WHERE u.Username = @username`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

export async function findById(userId: number): Promise<UserRecord | null> {
  const request = await createRequest()
  const result = await request
    .input('userId', sql.Int, userId)
    .query<UserRow>(`${SELECT_USER} WHERE u.UserId = @userId`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}

/** Clears the failed-attempt counter and any lock, and stamps the login. */
export async function recordSuccessfulLogin(userId: number): Promise<void> {
  const request = await createRequest()
  await request.input('userId', sql.Int, userId).query(`
      UPDATE dbo.Users
      SET    LastLoginAt = SYSUTCDATETIME(),
             FailedLoginCount = 0,
             LockedUntil = NULL,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  UserId = @userId`)
}

/**
 * Increments the failed-attempt counter, locking the account once it reaches
 * the threshold. The increment happens in SQL rather than read-then-write in
 * Node, so two simultaneous attempts cannot both read 4 and both store 5.
 */
export async function recordFailedLogin(
  userId: number,
  threshold: number,
  lockMinutes: number,
): Promise<void> {
  const request = await createRequest()
  await request
    .input('userId', sql.Int, userId)
    .input('threshold', sql.Int, threshold)
    .input('lockMinutes', sql.Int, lockMinutes).query(`
      UPDATE dbo.Users
      SET    FailedLoginCount = FailedLoginCount + 1,
             LockedUntil = CASE
                             WHEN FailedLoginCount + 1 >= @threshold
                               THEN DATEADD(MINUTE, @lockMinutes, SYSUTCDATETIME())
                             ELSE LockedUntil
                           END,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  UserId = @userId`)
}

export async function updatePassword(
  userId: number,
  password: PasswordRecord,
  mustChangePassword: boolean,
  transaction?: sql.Transaction,
): Promise<void> {
  const request = await createRequest(transaction)
  await request
    .input('userId', sql.Int, userId)
    .input('hash', sql.VarBinary(256), password.hash)
    .input('salt', sql.VarBinary(64), password.salt)
    .input('algorithm', sql.VarChar(30), password.algorithm)
    .input('mustChange', sql.Bit, mustChangePassword).query(`
      UPDATE dbo.Users
      SET    PasswordHash = @hash,
             PasswordSalt = @salt,
             PasswordAlgorithm = @algorithm,
             MustChangePassword = @mustChange,
             FailedLoginCount = 0,
             LockedUntil = NULL,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  UserId = @userId`)
}

export interface CreateUserInput {
  username: string
  fullName: string
  role: Role
  password: PasswordRecord
  mustChangePassword: boolean
}

export async function createUser(input: CreateUserInput): Promise<number> {
  const request = await createRequest()
  const result = await request
    .input('username', sql.NVarChar(100), input.username)
    .input('fullName', sql.NVarChar(150), input.fullName)
    .input('role', sql.VarChar(30), input.role)
    .input('hash', sql.VarBinary(256), input.password.hash)
    .input('salt', sql.VarBinary(64), input.password.salt)
    .input('algorithm', sql.VarChar(30), input.password.algorithm)
    .input('mustChange', sql.Bit, input.mustChangePassword).query<{ UserId: number }>(`
      INSERT INTO dbo.Users (Username, FullName, RoleId, PasswordHash, PasswordSalt,
                             PasswordAlgorithm, MustChangePassword)
      OUTPUT INSERTED.UserId
      SELECT @username, @fullName, r.RoleId, @hash, @salt, @algorithm, @mustChange
      FROM   dbo.Roles AS r
      WHERE  r.RoleName = @role`)

  const row = result.recordset[0]
  if (!row) {
    // Nothing inserted means the SELECT matched no role row.
    throw new Error(`Role ${input.role} does not exist. Run the seeds first.`)
  }
  return row.UserId
}

export async function usernameExists(username: string): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('username', sql.NVarChar(100), username)
    .query<{ Found: number }>(
      'SELECT TOP (1) 1 AS Found FROM dbo.Users WHERE Username = @username',
    )
  return result.recordset.length > 0
}

/**
 * How many accounts have been created through the registration form.
 *
 * Counted from the table, never from a running total: a count kept anywhere
 * else is a number that can disagree with the rows it claims to describe.
 */
export async function countSelfRegistered(): Promise<number> {
  const request = await createRequest()
  const result = await request.query<{ Total: number }>(
    'SELECT COUNT(*) AS Total FROM dbo.Users WHERE IsSelfRegistered = 1',
  )
  return result.recordset[0]?.Total ?? 0
}

/** Whether any account exists at all - which is what makes a system "empty". */
export async function anyUserExists(): Promise<boolean> {
  const request = await createRequest()
  const result = await request.query<{ Found: number }>(
    'SELECT TOP (1) 1 AS Found FROM dbo.Users',
  )
  return result.recordset.length > 0
}

/**
 * Creates a self-registered account, and REFUSES once the cap is reached.
 *
 * The cap is part of the INSERT rather than a check before it. Reading a count
 * and then writing leaves a window in which two people both read four and both
 * insert, and the limit that was the whole point of the feature is quietly
 * exceeded. Here the condition and the write are one statement, so the database
 * settles it and the loser simply inserts nothing.
 *
 * Returns null when the cap was reached, which the caller reports as a closed
 * registration rather than as a failure.
 */
export async function createSelfRegisteredUser(
  input: CreateUserInput & { maxSelfRegistrations: number },
): Promise<number | null> {
  const request = await createRequest()
  const result = await request
    .input('username', sql.NVarChar(100), input.username)
    .input('fullName', sql.NVarChar(150), input.fullName)
    .input('role', sql.VarChar(30), input.role)
    .input('hash', sql.VarBinary(256), input.password.hash)
    .input('salt', sql.VarBinary(64), input.password.salt)
    .input('algorithm', sql.VarChar(30), input.password.algorithm)
    .input('maxSelfRegistrations', sql.Int, input.maxSelfRegistrations)
    .query<{ UserId: number }>(`
      INSERT INTO dbo.Users (Username, FullName, RoleId, PasswordHash, PasswordSalt,
                             PasswordAlgorithm, MustChangePassword, IsSelfRegistered)
      OUTPUT INSERTED.UserId
      SELECT @username, @fullName, r.RoleId, @hash, @salt, @algorithm, 0, 1
      FROM   dbo.Roles AS r
      WHERE  r.RoleName = @role
        AND  (SELECT COUNT(*) FROM dbo.Users WITH (UPDLOCK, HOLDLOCK)
              WHERE IsSelfRegistered = 1) < @maxSelfRegistrations`)

  return result.recordset[0]?.UserId ?? null
}

/**
 * The first active account with a given role, for a command run by a person
 * who did not say which account to act as.
 *
 * Oldest first, which on this system is the account somebody set up when the
 * server was installed - the one an unattended import belongs to.
 *
 * The role is a ROW IN dbo.Roles, not a column on the user: dbo.Users carries
 * RoleId, and SELECT_USER is already joined to it. Filtering on 'u.Role' is
 * what this did, and the database refused it - halfway through an import, on
 * the first employee, because nothing before that point needed a user.
 */
export async function findFirstByRole(role: Role): Promise<UserRecord | null> {
  const request = await createRequest()
  const result = await request
    .input('role', sql.VarChar(20), role)
    .query<UserRow>(`${SELECT_USER} WHERE r.RoleName = @role AND u.IsActive = 1 ORDER BY u.UserId`)

  const row = result.recordset[0]
  return row ? toRecord(row) : null
}