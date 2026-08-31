import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.AuditLogs writes.
 *
 * Metadata arrives already sanitised by services/audit.service.ts and is stored
 * as NVARCHAR(MAX) JSON, parsed in Node - SQL Server 2014 has no JSON type and
 * none of its JSON functions.
 */

export interface AuditInsert {
  userId: number | null
  action: string
  entityType: string
  entityId: string | null
  ipAddress: string | null
  metadataJson: string | null
}

export async function insert(entry: AuditInsert, transaction?: sql.Transaction): Promise<void> {
  const request = await createRequest(transaction)
  await request
    .input('userId', sql.Int, entry.userId)
    .input('action', sql.VarChar(50), entry.action)
    .input('entityType', sql.VarChar(50), entry.entityType)
    .input('entityId', sql.VarChar(50), entry.entityId)
    .input('ipAddress', sql.VarChar(45), entry.ipAddress)
    .input('metadata', sql.NVarChar(sql.MAX), entry.metadataJson).query(`
      INSERT INTO dbo.AuditLogs (UserId, Action, EntityType, EntityId, IpAddress, Metadata)
      VALUES (@userId, @action, @entityType, @entityId, @ipAddress, @metadata)`)
}
