import {
  SIGNATURE_STATUS,
  canTransitionSignature,
  type AuthUser,
  type EmployeeDocument,
  type SignaturePlacement,
} from '@asps-dms/shared'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as signaturePlacementRepository from '../repositories/signaturePlacement.repository.js'
import type { RequestContext } from './auth.service.js'
import * as documentService from './document.service.js'
import { removeStamp } from './signature.service.js'

/**
 * Taking the application's stamp off documents that were signed before it
 * got to them.
 *
 * MMC prints the employee's signature and the HR stamp on the forms it
 * generates. For a while the application did not know that, saw the box as
 * empty - MMC's signature sits just outside it - and stamped the employee's
 * signature a second time. This puts those documents back: the placement rows
 * and the processed file go, so the original MMC file is served again, and
 * the signature status becomes SKIPPED - a person decided this document gets
 * no signature from the application - so nothing queues it for stamping
 * again. Everything goes through removeStamp, the same code the editor uses
 * when HR clears a document's placements.
 *
 * THE PLAN IS SEPARATE FROM THE DOING, and the plan is read-only. Every
 * document is looked at and given a verdict first - remove, or refused and
 * why - so --dry-run can print exactly what a live run would do, and a live
 * run does only what the plan said.
 *
 * ONLY AN AUTOMATIC STAMP IS REMOVED. A document with any placement a
 * person put there - Manual, Adjusted, Accepted - is refused, whatever else
 * is true of it: somebody decided that, and a command run from a list of ids
 * is not the place to undo it. A document with no placements, no processed
 * file, or a status Skipped cannot follow from is refused too. Refusals are
 * per document; the rest of the list is still done.
 */

export type UnstampVerdict = { action: 'remove' } | { action: 'refuse'; reason: string }

export interface UnstampPlanLine {
  documentId: number
  /** Null when the document does not exist. */
  document: EmployeeDocument | null
  placements: SignaturePlacement[]
  processedFilePath: string | null
  verdict: UnstampVerdict
}

export interface UnstampPlan {
  lines: UnstampPlanLine[]
  toRemove: UnstampPlanLine[]
  refused: UnstampPlanLine[]
}

/** The reasons a document is refused, in the words the console prints. */
export const UNSTAMP_REFUSALS = {
  notFound: 'no such document',
  noFile: 'no stored file',
  noPlacements: 'no placements - nothing is stamped on it',
  notAllAutomatic: (methods: readonly string[]) =>
    `placed by a person (${methods.join(', ')}) - not the application`,
  noProcessedFile: 'placements are recorded but there is no processed file',
  cannotSkip: (status: string) => `a document whose signature is '${status}' cannot be skipped`,
} as const

function verdictFor(
  document: EmployeeDocument | null,
  placements: readonly SignaturePlacement[],
  processedFilePath: string | null,
): UnstampVerdict {
  if (!document) return { action: 'refuse', reason: UNSTAMP_REFUSALS.notFound }
  if (document.originalFileName === null) {
    return { action: 'refuse', reason: UNSTAMP_REFUSALS.noFile }
  }
  if (placements.length === 0) {
    return { action: 'refuse', reason: UNSTAMP_REFUSALS.noPlacements }
  }
  const byPerson = placements.filter((placement) => placement.method !== 'Automatic')
  if (byPerson.length > 0) {
    const methods = [...new Set(byPerson.map((placement) => placement.method))].sort()
    return { action: 'refuse', reason: UNSTAMP_REFUSALS.notAllAutomatic(methods) }
  }
  if (processedFilePath === null) {
    return { action: 'refuse', reason: UNSTAMP_REFUSALS.noProcessedFile }
  }
  if (!canTransitionSignature(document.signatureStatus, SIGNATURE_STATUS.SKIPPED)) {
    return { action: 'refuse', reason: UNSTAMP_REFUSALS.cannotSkip(document.signatureStatus) }
  }
  return { action: 'remove' }
}

/** The ids named, in the order given, each once. */
export function parseDocumentIds(text: string): number[] {
  const seen = new Set<number>()
  const ids: number[] = []
  for (const piece of text.split(/[\s,]+/)) {
    if (piece.length === 0) continue
    const id = Number(piece)
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`'${piece}' is not a document id`)
    }
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export interface PlanDeps {
  findDocument: (documentId: number) => Promise<EmployeeDocument | null>
  listPlacements: (documentId: number) => Promise<SignaturePlacement[]>
  findStoredFile: (documentId: number) => Promise<{ processedFilePath: string | null } | null>
}

/**
 * Looks at every document and says what a live run would do to it. Reads
 * only; nothing here writes, so a dry run is this and printing.
 */
export async function plan(
  documentIds: readonly number[],
  deps: PlanDeps = defaultDeps(),
): Promise<UnstampPlan> {
  const lines: UnstampPlanLine[] = []
  for (const documentId of documentIds) {
    const document = await deps.findDocument(documentId)
    const placements = document ? await deps.listPlacements(documentId) : []
    const location = document ? await deps.findStoredFile(documentId) : null
    const processedFilePath = location?.processedFilePath ?? null
    lines.push({
      documentId,
      document,
      placements,
      processedFilePath,
      verdict: verdictFor(document, placements, processedFilePath),
    })
  }
  return {
    lines,
    toRemove: lines.filter((line) => line.verdict.action === 'remove'),
    refused: lines.filter((line) => line.verdict.action === 'refuse'),
  }
}

export interface UnstampOutcome {
  documentId: number
  placementsRemoved: number
  processedFileRemoved: boolean
}

/**
 * Does what the plan said, and only that: each 'remove' line goes through
 * removeStamp, in order, with the reason on the audit entry. A refused line
 * is not touched. One failure does not stop the next; it is reported.
 */
export async function apply(
  planned: UnstampPlan,
  options: {
    reason: string
    actor: AuthUser
    context: RequestContext
    onEach?: (outcome: UnstampOutcome | { documentId: number; error: unknown }) => void
    remove?: typeof removeStamp
  },
): Promise<{ done: UnstampOutcome[]; failed: { documentId: number; error: unknown }[] }> {
  const remove = options.remove ?? removeStamp
  const done: UnstampOutcome[] = []
  const failed: { documentId: number; error: unknown }[] = []

  for (const line of planned.toRemove) {
    // The plan checked this; the type does not know it.
    if (!line.document) continue
    try {
      const result = await remove(line.document, options.actor, options.context, {
        nextStatus: SIGNATURE_STATUS.SKIPPED,
        source: 'unstamp command',
        reason: options.reason,
      })
      const outcome = { documentId: line.documentId, ...result }
      done.push(outcome)
      options.onEach?.(outcome)
    } catch (error) {
      const failure = { documentId: line.documentId, error }
      failed.push(failure)
      options.onEach?.(failure)
    }
  }

  return { done, failed }
}

function defaultDeps(): PlanDeps {
  return {
    findDocument: async (documentId) => {
      // The service's getById throws for a missing document; the plan wants
      // a line saying so instead.
      try {
        return await documentService.getById(documentId)
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null
        throw error
      }
    },
    listPlacements: signaturePlacementRepository.listForDocument,
    findStoredFile: employeeDocumentRepository.findStoredFile,
  }
}
