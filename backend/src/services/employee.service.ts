import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  computeDueDate,
  type AuthUser,
  type CreateEmployeeInput,
  type EmployeeDocument,
  type EmployeeListItem,
  type EmployeeListQuery,
  type EmployeeProfile,
  type Paginated,
  type UpdateEmployeeInput,
} from '@asps-dms/shared'
import { withTransaction } from '../database/pool.js'
import { withDeadline } from './document.service.js'
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import { ConflictError, NotFoundError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'

/**
 * Employee records and their document checklist.
 *
 * The rule that shapes this file: an employee and their checklist are created
 * together or not at all. A record with no checklist would report zero
 * outstanding documents, which is the most dangerous wrong answer this system
 * can give - it looks exactly like a fully compliant employee.
 */

/** SQL Server's unique-constraint violations, by error number. */
function isUniqueViolation(error: unknown): boolean {
  const number = (error as { number?: unknown }).number
  return number === 2627 || number === 2601
}

export async function list(query: EmployeeListQuery): Promise<Paginated<EmployeeListItem>> {
  return employeeRepository.list(query)
}

export async function listFacets(): Promise<{ departments: string[]; designations: string[] }> {
  return employeeRepository.listFacets()
}

/** The profile, or a 404. Archived employees are still readable by id. */
export async function getById(employeeId: number): Promise<EmployeeProfile> {
  const employee = await employeeRepository.findById(employeeId)
  if (!employee) throw new NotFoundError('That employee record does not exist.')
  return employee
}

/**
 * Creates an employee and materialises their document checklist.
 *
 * Due dates are computed here, by the shared rules, rather than with DATEADD in
 * the INSERT: joiningDate + 10 DAY has one definition in this codebase
 * (shared/src/utils/deadline.ts), it is unit-tested there, and the browser
 * previews the same numbers from the same function.
 */
export async function create(
  input: CreateEmployeeInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  let created: { employeeId: number; employeeCode: string }
  let checklistSize = 0

  try {
    created = await withTransaction(async (tx) => {
      const employee = await employeeRepository.create(input, actor.userId, tx)

      // Read inside the transaction: the checklist must reflect the document
      // types as they are in this unit of work, not as they were a moment ago.
      const documentTypes = await documentTypeRepository.listActive(tx)
      checklistSize = await employeeDocumentRepository.createChecklist(
        employee.employeeId,
        documentTypes.map((type) => ({
          documentTypeId: type.documentTypeId,
          dueDate: computeDueDate(input.joiningDate, type.deadlineValue, type.deadlineUnit),
        })),
        tx,
      )

      return employee
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      // dbo.EmployeeCodeSeq cannot repeat itself, so this means a code was
      // inserted by hand at a value the sequence has yet to reach. Saying so is
      // the only way anyone will find that.
      throw new ConflictError(
        'That employee code is already in use. The employee code sequence may need to be reset.',
        undefined,
        { cause: error },
      )
    }
    throw error
  }

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.EMPLOYEE_CREATED,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: created.employeeId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: created.employeeCode,
      employeeName: input.employeeName,
      joiningDate: input.joiningDate,
      checklistRows: checklistSize,
    },
  })

  return getById(created.employeeId)
}

export async function update(
  employeeId: number,
  input: UpdateEmployeeInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  const existing = await getById(employeeId)

  await employeeRepository.update(employeeId, input)

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.EMPLOYEE_UPDATED,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    // What changed, and what it was before: an audit entry that records only
    // the new value cannot answer "who set this to that".
    metadata: {
      employeeCode: existing.employeeCode,
      changes: describeChanges(existing, input),
    },
  })

  return getById(employeeId)
}

function describeChanges(
  existing: EmployeeProfile,
  input: UpdateEmployeeInput,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const fields = ['employeeName', 'joiningDate', 'department', 'designation'] as const

  for (const field of fields) {
    if (!(field in input)) continue
    const to = input[field] ?? null
    const from = existing[field]
    if (from !== to) changes[field] = { from, to }
  }
  return changes
}

/**
 * Archives or restores an employee.
 *
 * Idempotent: asking to archive an already archived employee is not an error,
 * it is a repeated click. Nothing is written and nothing is audited, because
 * an audit trail full of no-op entries is a worse trail.
 */
export async function setArchived(
  employeeId: number,
  archived: boolean,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  const existing = await getById(employeeId)
  if (existing.isActive === !archived) return existing

  await employeeRepository.setActive(employeeId, !archived)

  await audit.record({
    userId: actor.userId,
    action: archived ? AUDIT_ACTIONS.EMPLOYEE_ARCHIVED : AUDIT_ACTIONS.EMPLOYEE_RESTORED,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    metadata: { employeeCode: existing.employeeCode, employeeName: existing.employeeName },
  })

  return getById(employeeId)
}

/**
 * An employee's checklist, with deadline state derived at read time.
 *
 * The state is computed here from DueDate rather than read from a column, so
 * "Overdue" is true the day it becomes true, with no scheduled job to run and
 * no stale flag to reconcile.
 */
export async function listDocuments(employeeId: number): Promise<EmployeeDocument[]> {
  await getById(employeeId)
  const records = await employeeDocumentRepository.listForEmployee(employeeId)
  return records.map(withDeadline)
}
