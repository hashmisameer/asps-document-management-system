import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, computeDueDate, type AuthUser } from '@asps-dms/shared'
import type { sql } from '../database/pool.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import type { DeadlineCandidate } from '../repositories/employeeDocument.repository.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'

/**
 * Putting a document's deadline back in step with its employee's joining date.
 *
 * A deadline is the joining date plus the document type's allowance, worked out
 * once by computeDueDate and written when the checklist is created. For a long
 * while nothing recomputed it, so correcting a joining date left every deadline
 * where it was: three employees had a date of birth typed into the joining date,
 * were corrected afterwards, and went on being chased against deadlines in 1988,
 * 1989, 1993 and 2009.
 *
 * TWO CALLERS, ONE RULE. The employee edit moves the deadlines of the employee
 * whose joining date just changed, in the same transaction as the edit; the
 * recompute-deadlines command sweeps every employee whose rows disagree. Both
 * decide what to move here, so the screen and the command cannot drift apart.
 *
 * ONLY ROWS WITH NO FILE, which the repository's query enforces - a document
 * that has arrived keeps the date that applied to it (migrations 0023 and 0034).
 *
 * THE PLAN IS SEPARATE FROM THE DOING, and the plan writes nothing: the
 * command's --dry-run is this and printing.
 */

/** One deadline that is in the wrong place, and where it belongs. */
export interface DeadlineMove {
  documentId: number
  employeeId: number
  employeeCode: string
  documentName: string
  from: string | null
  to: string | null
  /** A person had moved this deadline by hand; this overwrites that. */
  wasOverridden: boolean
}

/**
 * Which of these rows disagree with their employee's joining date.
 *
 * Pure: candidates in, moves out, no clock and no database. A row already on
 * the right date is not a move, which is what makes running this twice a
 * no-op - and what makes 'nothing moved' an answer rather than a silence.
 */
export function planMoves(candidates: readonly DeadlineCandidate[]): DeadlineMove[] {
  const moves: DeadlineMove[] = []

  for (const candidate of candidates) {
    const should = computeDueDate(
      candidate.joiningDate,
      candidate.deadlineValue,
      candidate.deadlineUnit,
    )
    if (should === candidate.dueDate) continue

    moves.push({
      documentId: candidate.documentId,
      employeeId: candidate.employeeId,
      employeeCode: candidate.employeeCode,
      documentName: candidate.documentName,
      from: candidate.dueDate,
      to: should,
      wasOverridden: candidate.wasOverridden,
    })
  }

  return moves
}

/** The moves one employee's documents need, after their joining date changed. */
export async function planForEmployee(
  employeeId: number,
  transaction?: sql.Transaction,
): Promise<DeadlineMove[]> {
  return planMoves(await employeeDocumentRepository.listDeadlineCandidates(employeeId, transaction))
}

/** The moves every employee needs - the sweep. */
export async function planForEveryone(limit: number): Promise<DeadlineMove[]> {
  return planMoves(await employeeDocumentRepository.listAllDeadlineCandidates(limit))
}

/**
 * Writes the moves, one DEADLINE_CHANGED entry each.
 *
 * The same action a person's own deadline change writes, because it answers the
 * same question months later - why is this document's date not the one the
 * checklist would give? The reason says what moved it, so an automatic move and
 * a decision by HR read apart in the trail.
 */
export async function applyMoves(
  moves: readonly DeadlineMove[],
  options: {
    actor: AuthUser
    context: RequestContext
    /** Why, in the words the audit trail should carry. */
    reason: string
    transaction?: sql.Transaction
  },
): Promise<number> {
  for (const move of moves) {
    await employeeDocumentRepository.setDueDate(move.documentId, move.to, options.transaction)

    await audit.record(
      {
        userId: options.actor.userId,
        action: AUDIT_ACTIONS.DEADLINE_CHANGED,
        entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
        entityId: move.documentId,
        ipAddress: options.context.ipAddress,
        metadata: {
          employeeCode: move.employeeCode,
          documentName: move.documentName,
          from: move.from,
          to: move.to,
          reason: options.reason,
          ...(move.wasOverridden ? { overwroteManualDeadline: true } : {}),
        },
      },
      options.transaction,
    )
  }

  return moves.length
}
