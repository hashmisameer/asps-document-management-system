import type { Request } from 'express'
import {
  AUDIT_REDACTED_KEYS,
  type AuditAction,
  type AuditEntityType,
} from '@asps-dms/shared'
import * as auditRepository from '../repositories/audit.repository.js'
import { logger } from '../utils/logger.js'
import { describeError } from '../utils/errors.js'

/**
 * The audit trail (Section 48).
 *
 * Two rules shape this file:
 *
 *   1. Nothing sensitive is written. Metadata is filtered against
 *      AUDIT_REDACTED_KEYS before it is serialised, so a password, token or
 *      file buffer cannot reach the table even if a caller passes one in. The
 *      filter is here rather than at each call site because a call site that
 *      forgets is exactly the failure this must survive.
 *   2. Auditing never fails the action it describes. A failed insert is logged
 *      and swallowed: refusing a login because the audit table is full would
 *      turn a housekeeping problem into an outage.
 */

const MAX_METADATA_LENGTH = 4_000
const MAX_DEPTH = 4

const redactedKeys = new Set(AUDIT_REDACTED_KEYS.map((key) => key.toLowerCase()))

/**
 * Drops redacted keys at any depth, and anything that is not plain JSON data.
 * A Buffer or a stream reaching this point would be a document's contents.
 */
export function sanitiseMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (depth > MAX_DEPTH) return '[truncated]'

  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}...` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return '[binary]'
  if (typeof value === 'function' || typeof value === 'symbol') return undefined

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitiseMetadata(item, depth + 1))
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (redactedKeys.has(key.toLowerCase())) {
        result[key] = '[redacted]'
        continue
      }
      const sanitised = sanitiseMetadata(item, depth + 1)
      if (sanitised !== undefined) result[key] = sanitised
    }
    return result
  }

  return undefined
}

function serialiseMetadata(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null

  try {
    const json = JSON.stringify(sanitiseMetadata(metadata))
    if (json === undefined) return null
    return json.length > MAX_METADATA_LENGTH ? `${json.slice(0, MAX_METADATA_LENGTH)}"...` : json
  } catch (err) {
    // A circular structure is a caller bug, not a reason to lose the entry.
    logger.warn({ err }, 'Audit metadata could not be serialised; storing without it')
    return null
  }
}

export interface AuditEntry {
  userId: number | null
  action: AuditAction
  entityType: AuditEntityType
  entityId?: string | number | null
  ipAddress?: string | null
  metadata?: Record<string, unknown>
}

export async function record(entry: AuditEntry): Promise<void> {
  try {
    await auditRepository.insert({
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId === null || entry.entityId === undefined ? null : String(entry.entityId),
      ipAddress: entry.ipAddress ?? null,
      metadataJson: serialiseMetadata(entry.metadata),
    })
  } catch (err) {
    // Loud in the log, invisible to the user's request.
    logger.error(
      { err, action: entry.action, entityType: entry.entityType },
      `Audit entry could not be written: ${describeError(err)}`,
    )
  }
}

/**
 * The caller's IP, truncated to the column width.
 *
 * `trust proxy` is off (see app.ts), so this is the socket address and cannot
 * be spoofed with a header - which is the only reason it is worth auditing.
 */
export function clientIp(req: Request): string | null {
  return req.ip?.slice(0, 45) ?? null
}

/** Who and where a request came from, as every service records it. */
export function requestContext(req: Request): {
  ipAddress: string | null
  userAgent: string | null
} {
  return { ipAddress: clientIp(req), userAgent: req.get('user-agent') ?? null }
}
