import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  EMPLOYMENT_STATUSES,
  computeDueDate,
  todayDateOnly,
  type AuthUser,
  type CreateEmployeeInput,
  type EmployeeDocument,
  type EmployeeListItem,
  type EmployeeListQuery,
  type EmployeeProfile,
  type MarkEmployeeLeftInput,
  type Paginated,
  type UpdateEmployeeInput,
} from '@asps-dms/shared'
import { withTransaction } from '../database/pool.js'
import { withDeadline } from './document.service.js'
import {
  bulkFileName,
  formFileName,
  renderEmployeeFile,
  renderEmployeeForms,
  type EmployeeFormData,
} from './employeeForm.service.js'
import type { DocumentEntry } from './documentPages.service.js'
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import * as audit from './audit.service.js'
import * as storage from './storage.service.js'
import { inspectSignatureUpload, type UploadedFile } from './fileValidation.service.js'
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
      // Two ways to arrive here, and they need different things said. A code
      // that was typed is simply taken. A code that was GENERATED colliding
      // means the sequence has reached a number somebody entered by hand
      // earlier - which nobody would ever find without being told.
      throw new ConflictError(
        input.employeeCode
          ? `Employee ID ${input.employeeCode} is already in use.`
          : 'The generated employee code is already in use, which means one was ' +
            'entered by hand at a value the sequence has now reached. Enter the ' +
            'ID for this employee, or reset dbo.EmployeeCodeSeq past it.',
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

/**
 * Identity numbers, whose VALUES never reach the audit trail.
 *
 * That a PAN number was changed is worth recording; what it was changed from is
 * a copy of the number in a table read by more people and kept for longer than
 * the employee record itself. The field name goes in, the value does not.
 */
const NEVER_AUDITED_VALUES: ReadonlySet<string> = new Set([
  'aadhaarNumber',
  'panNumber',
  'uanNumber',
  'esiNumber',
])

/**
 * What this edit changed.
 *
 * Driven by the KEYS THE CALLER SENT rather than by a list kept here. It was a
 * hard-coded five, and every field added since - a phone number, an address, an
 * email, a date of birth - was edited without the trail recording anything at
 * all: the entry said an employee had been updated and left the 'changes'
 * object empty. A list in one place that has to be remembered in another is a
 * list that goes stale, and this one had.
 */
function describeChanges(
  existing: EmployeeProfile,
  input: UpdateEmployeeInput,
): Record<string, { from: unknown; to: unknown } | { changed: true }> {
  const changes: Record<string, { from: unknown; to: unknown } | { changed: true }> = {}

  for (const [field, value] of Object.entries(input)) {
    const to = value ?? null
    const from = (existing as unknown as Record<string, unknown>)[field] ?? null
    if (from === to) continue

    changes[field] = NEVER_AUDITED_VALUES.has(field) ? { changed: true } : { from, to }
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
 * Records that an employee has left.
 *
 * The two dates are checked against each other AND against the joining date.
 * The database enforces the same three rules, but a constraint violation
 * arrives as a 500 and a sentence nobody outside this file can read; these
 * produce a message that says which date is wrong and why.
 *
 * The status is decided by the last working date, not by this call. Someone who
 * resigns on the 1st to leave on the 30th is still employed for those thirty
 * days - still paid, still on the checklist - so the record says LEFT only once
 * that day has passed.
 */
export async function markLeft(
  employeeId: number,
  input: MarkEmployeeLeftInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  const existing = await getById(employeeId)

  if (input.lastWorkingDate < input.resignationDate) {
    throw new ValidationError([
      {
        path: 'lastWorkingDate',
        message: 'The last working date cannot be before the resignation date.',
      },
    ])
  }
  if (input.resignationDate < existing.joiningDate) {
    throw new ValidationError([
      {
        path: 'resignationDate',
        message: `The resignation date cannot be before the employee joined on ${formatForMessage(existing.joiningDate)}.`,
      },
    ])
  }
  if (input.lastWorkingDate < existing.joiningDate) {
    throw new ValidationError([
      {
        path: 'lastWorkingDate',
        message: `The last working date cannot be before the employee joined on ${formatForMessage(existing.joiningDate)}.`,
      },
    ])
  }

  const alreadyLeaving = existing.resignationDate !== null
  await employeeRepository.markLeft(employeeId, input, todayDateOnly())

  await audit.record({
    userId: actor.userId,
    action: alreadyLeaving
      ? AUDIT_ACTIONS.EMPLOYEE_EXIT_UPDATED
      : AUDIT_ACTIONS.EMPLOYEE_MARKED_LEFT,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    // The dates and the reason, because the whole point of the trail is being
    // able to answer 'who said this person left, and when did they say it'.
    // The free-text note is not copied here; it lives on the record.
    metadata: {
      employeeCode: existing.employeeCode,
      employeeName: existing.employeeName,
      resignationDate: input.resignationDate,
      lastWorkingDate: input.lastWorkingDate,
      exitReason: input.exitReason,
      previousResignationDate: existing.resignationDate,
      previousLastWorkingDate: existing.lastWorkingDate,
    },
  })

  return getById(employeeId)
}

/**
 * Undoes an exit.
 *
 * For the case this exists to serve: the wrong employee was marked as having
 * left. The status and every exit date go back to how they were, and the record
 * of it having happened stays in the audit trail, which is the only place that
 * should be permanent.
 */
export async function undoExit(
  employeeId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  const existing = await getById(employeeId)
  // Nothing recorded means nothing to undo - a repeated click, not an error.
  if (existing.resignationDate === null && existing.employmentStatus === EMPLOYMENT_STATUSES.ACTIVE) {
    return existing
  }

  await employeeRepository.undoExit(employeeId)

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.EMPLOYEE_EXIT_UNDONE,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: existing.employeeCode,
      employeeName: existing.employeeName,
      // What was undone, so the trail reads as a pair rather than as a bare
      // 'undone' with nothing to say what.
      resignationDate: existing.resignationDate,
      lastWorkingDate: existing.lastWorkingDate,
      exitReason: existing.exitReason,
    },
  })

  return getById(employeeId)
}

/** A date written the way the office writes it, for a message. */
function formatForMessage(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-')
  return `${day}/${month}/${year}`
}

/**
 * An employee's checklist, with deadline state derived at read time.
 *
 * The state is computed here from DueDate rather than read from a column, so
 * "Overdue" is true the day it becomes true, with no scheduled job to run and
 * no stale flag to reconcile.
 */
export async function listDocuments(employeeId: number): Promise<EmployeeDocument[]> {
  // Read for its own sake as well as to prove the employee exists: once they
  // have left, their outstanding documents stop being overdue.
  const employee = await getById(employeeId)
  const employeeHasLeft = employee.employmentStatus === EMPLOYMENT_STATUSES.LEFT

  const records = await employeeDocumentRepository.listForEmployee(employeeId)
  return records.map((record) => withDeadline(record, { employeeHasLeft }))
}

/**
 * Uploads or replaces an employee's photograph.
 *
 * Validated exactly as a signature image is - PNG or JPEG by CONTENT, size
 * capped, and a PNG proved whole before any decoder sees it - because the same
 * two upload paths reach the same libraries, and a photograph is no more
 * trustworthy than any other file somebody chose.
 *
 * The file is written before the row is updated. An orphaned file is
 * housekeeping; a row pointing at a file that was never written is a broken
 * image on somebody's record.
 */
export async function uploadPhoto(
  employeeId: number,
  file: UploadedFile,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeProfile> {
  await getById(employeeId)

  const inspected = await inspectSignatureUpload(file)
  const stored = await storage.storePhoto(employeeId, file.buffer, inspected.extension)

  await employeeRepository.setPhoto(employeeId, {
    filePath: stored.relativePath,
    mimeType: inspected.mimeType,
    sizeBytes: stored.sizeBytes,
  })

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.EMPLOYEE_UPDATED,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    // The file name is not recorded: it is chosen by whoever uploaded it and
    // can carry a person's name, which the audit trail keeps for longer than
    // the record does.
    metadata: { change: 'photo', sizeBytes: stored.sizeBytes, mimeType: inspected.mimeType },
  })

  return getById(employeeId)
}

/** Streams an employee's photograph. */
export async function openPhoto(
  employeeId: number,
): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
  const photo = await employeeRepository.findPhoto(employeeId)
  if (!photo) throw new NotFoundError('No photograph has been uploaded for this employee.')

  if (!(await storage.storedFileExists(photo.filePath))) {
    throw new ConflictError(
      'The photograph is recorded but its file is missing from the document store. ' +
        'Tell your administrator.',
    )
  }

  return { stream: storage.openStoredFile(photo.filePath), mimeType: photo.mimeType }
}

/**
 * The printed form for one or more employees, as a single PDF.
 *
 * Everything on the page is read here and rendered in employeeForm.service.ts,
 * which is given plain data and no database: what goes on the paper can then be
 * tested against a fixture, and what is READ for it stays beside every other
 * read of an employee.
 *
 * The reads are per employee rather than one query for all of them. Printing a
 * form is not a hot path - it happens when somebody is about to walk to a
 * printer - and the checklist state each form shows is then the same state,
 * from the same functions, that the employee's own screen shows. A bulk query
 * would be a second definition of "received" to keep in step with the first.
 */
export async function printForms(
  employeeIds: readonly number[],
  actor: AuthUser,
): Promise<{ fileName: string; pdf: Buffer }> {
  // Selecting the same person twice - on two pages of the list, say - prints
  // them once. Order follows the selection, which is the order they were
  // listed in.
  const ids = [...new Set(employeeIds)]

  const forms: EmployeeFormData[] = []
  for (const employeeId of ids) {
    const employee = await getById(employeeId)
    forms.push({
      employee,
      documents: await listDocuments(employeeId),
      photo: await readPhotoForPrint(employeeId),
    })
  }

  const generatedAt = new Date()
  const pdf = await renderEmployeeForms(forms, {
    generatedAt,
    generatedBy: actor.fullName,
  })

  const only = forms.length === 1 ? forms[0] : undefined
  return { fileName: only ? formFileName(only.employee) : bulkFileName(generatedAt), pdf }
}

/**
 * The photograph, for the form's letterhead. Null when there is not one.
 *
 * A missing FILE is not an error here, unlike the route that streams the
 * photograph: the form is a checklist, and refusing to print somebody's
 * outstanding documents because their picture has gone astray would be a
 * strange way to report that. It is logged and the form is drawn without it.
 */
async function readPhotoForPrint(
  employeeId: number,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const photo = await employeeRepository.findPhoto(employeeId)
  if (!photo) return null

  try {
    if (!(await storage.storedFileExists(photo.filePath))) {
      logger.warn({ employeeId }, 'photograph is recorded but missing; printing the form without it')
      return null
    }
    return { data: await storage.readStoredFile(photo.filePath), mimeType: photo.mimeType }
  } catch (error) {
    logger.warn({ err: error, employeeId }, 'photograph could not be read for the printed form')
    return null
  }
}

/**
 * Which of an employee's documents have a file behind them, and where it is.
 *
 * NOT the file contents. Each entry carries a function that reads it when its
 * turn comes, so a file of ten scans never holds ten scans in memory at once -
 * see DocumentFile.read. A read that fails is left to fail there, where the
 * renderer turns it into a page saying so; there is nothing useful to do about
 * it here that would not amount to hiding it.
 *
 * The SIGNED copy where there is one, exactly as downloading a single document
 * gives you - see openForDelivery, which makes the same choice for the same
 * reason.
 */
async function collectDocumentFiles(employeeId: number): Promise<DocumentEntry[]> {
  const documents = await listDocuments(employeeId)
  const included: DocumentEntry[] = []

  for (const document of documents) {
    const location = await employeeDocumentRepository.findStoredFile(document.documentId)
    const relativePath = location?.processedFilePath ?? location?.originalFilePath ?? null

    // A checklist row with no file behind it is simply not in the file. It is
    // not named as missing either: what the office is still chasing is not for
    // the copy that gets handed to somebody outside.
    if (!relativePath) continue

    const isSigned = location?.processedFilePath !== null

    included.push({
      documentName: document.documentName,
      isMandatory: document.isMandatory,
      uploadedAt: document.uploadedAt,
      uploadedByName: document.uploadedByName,
      file: {
        read: () => storage.readStoredFile(relativePath),
        // The processed copy is always a PDF, whatever the original was.
        mimeType: isSigned ? 'application/pdf' : (location?.mimeType ?? ''),
        isSigned,
      },
    })
  }

  return included
}

/**
 * One employee's file: their details, then every document they have sent in.
 *
 * What the Print form button on their own page now produces. It used to be the
 * checklist - which the list page's 'Print selected' still prints, and which is
 * still the right paper for chasing somebody. This is the other question the
 * office gets asked: send me their file.
 *
 * Audited, unlike the checklist print it replaced, and for the reason the
 * change makes necessary: this hands over the documents themselves.
 */
export async function printEmployeeFile(
  employeeId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<{ fileName: string; pdf: Buffer }> {
  const employee = await getById(employeeId)
  const included = await collectDocumentFiles(employeeId)

  const generatedAt = new Date()
  const pdf = await renderEmployeeFile(
    { employee, photo: await readPhotoForPrint(employeeId), documents: included },
    { generatedAt, generatedBy: actor.fullName },
  )

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
    entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: employee.employeeCode,
      documentCount: included.length,
      documents: included.map((entry) => entry.documentName),
    },
  })

  return { fileName: formFileName(employee), pdf }
}
