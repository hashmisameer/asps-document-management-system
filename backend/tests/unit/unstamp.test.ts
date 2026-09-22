import { describe, expect, it, vi } from 'vitest'
import {
  ROLES,
  SIGNATURE_STATUS,
  type AuthUser,
  type EmployeeDocument,
  type SignaturePlacement,
} from '@asps-dms/shared'
import {
  UNSTAMP_REFUSALS,
  apply,
  parseDocumentIds,
  plan,
  type PlanDeps,
} from '../../src/services/unstamp.service.js'

/**
 * Taking the application's stamp off: what is refused, what a dry run touches
 * (nothing), and what a live run hands to removeStamp.
 *
 * The removal itself - rows, file, status, audit - is removeStamp's, pinned
 * with the editor's empty save in signature.service.test.ts. Here the plan's
 * verdicts and the command's discipline: only Automatic placements, only what
 * the plan said, one failure never stopping the next.
 */

const actor: AuthUser = {
  userId: 1,
  username: 'admin',
  fullName: 'Administrator',
  role: ROLES.ADMIN,
  mustChangePassword: false,
}
const context = { ipAddress: null, userAgent: 'test' }

function document(overrides: Partial<EmployeeDocument> = {}): EmployeeDocument {
  return {
    documentId: 5765,
    employeeId: 42,
    employeeCode: '00006133',
    employeeName: 'Ajay Prakash',
    documentTypeId: 3,
    documentName: 'PF Form / Form 11',
    documentCode: 'PF_FORM',
    isMandatory: true,
    requiresSignature: true,
    originalFileName: 'pf.pdf',
    fileSizeBytes: 2048,
    mimeType: 'application/pdf',
    pageCount: 2,
    hasProcessedFile: true,
    status: 'Uploaded',
    signatureStatus: SIGNATURE_STATUS.ADDED,
    identityCheck: null,
    stampDecision: null,
    dueDate: null,
    employeeHasLeft: false,
    ...overrides,
  } as EmployeeDocument
}

function placement(method: SignaturePlacement['method'], id = 1): SignaturePlacement {
  return {
    signaturePlacementId: id,
    documentId: 5765,
    employeeId: 42,
    pageNumber: 2,
    x: 0.6,
    y: 0.7,
    width: 0.25,
    height: 0.08,
    pageRotation: 0,
    method,
    detectionMethod: method === 'Automatic' ? 'Template' : 'Manual',
    confidence: null,
    signerRole: 'Employee',
    signerUserId: null,
    signerName: null,
    isApplied: true,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
}

/** A database of a few documents, read through the plan's dependencies. */
function world(
  docs: Record<
    number,
    { document: EmployeeDocument; placements: SignaturePlacement[]; processed: string | null }
  >,
): PlanDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    findDocument: async (id) => {
      reads.push(`document ${id}`)
      return docs[id]?.document ?? null
    },
    listPlacements: async (id) => {
      reads.push(`placements ${id}`)
      return docs[id]?.placements ?? []
    },
    findStoredFile: async (id) => {
      reads.push(`file ${id}`)
      return { processedFilePath: docs[id]?.processed ?? null }
    },
  }
}

const automatic = {
  document: document(),
  placements: [placement('Automatic', 1), placement('Automatic', 2)],
  processed: 'processed/42/signed.pdf',
}

describe('the plan', () => {
  it('removes a document whose every placement the application put there', async () => {
    const planned = await plan([5765], world({ 5765: automatic }))

    expect(planned.toRemove.map((line) => line.documentId)).toEqual([5765])
    expect(planned.refused).toEqual([])
    expect(planned.lines[0]?.verdict).toEqual({ action: 'remove' })
  })

  it('refuses a document with any placement a person put there, and says which', async () => {
    const planned = await plan(
      [1, 2],
      world({
        1: { ...automatic, placements: [placement('Manual', 1), placement('Manual', 2)] },
        2: { ...automatic, placements: [placement('Automatic', 1), placement('Adjusted', 2)] },
      }),
    )

    expect(planned.toRemove).toEqual([])
    expect(planned.refused.map((line) => line.verdict)).toEqual([
      { action: 'refuse', reason: UNSTAMP_REFUSALS.notAllAutomatic(['Manual']) },
      { action: 'refuse', reason: UNSTAMP_REFUSALS.notAllAutomatic(['Adjusted']) },
    ])
  })

  it('refuses what there is nothing to do to: no document, no file, no placements, no processed file', async () => {
    const planned = await plan(
      [9, 10, 11, 12],
      world({
        10: { ...automatic, document: document({ originalFileName: null }) },
        11: { ...automatic, placements: [] },
        12: { ...automatic, processed: null },
      }),
    )

    expect(planned.toRemove).toEqual([])
    expect(planned.lines.map((line) => line.verdict)).toEqual([
      { action: 'refuse', reason: UNSTAMP_REFUSALS.notFound },
      { action: 'refuse', reason: UNSTAMP_REFUSALS.noFile },
      { action: 'refuse', reason: UNSTAMP_REFUSALS.noPlacements },
      { action: 'refuse', reason: UNSTAMP_REFUSALS.noProcessedFile },
    ])
  })

  it('refuses a document whose status cannot become Skipped', async () => {
    const planned = await plan(
      [1],
      world({
        1: { ...automatic, document: document({ signatureStatus: SIGNATURE_STATUS.NOT_REQUIRED }) },
      }),
    )
    expect(planned.lines[0]?.verdict).toEqual({
      action: 'refuse',
      reason: UNSTAMP_REFUSALS.cannotSkip('NotRequired'),
    })
  })

  it('accepts Added and ReviewRequired alike', async () => {
    const planned = await plan(
      [1, 2],
      world({
        1: automatic,
        2: {
          ...automatic,
          document: document({ signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED }),
        },
      }),
    )
    expect(planned.toRemove).toHaveLength(2)
  })

  it('keeps the list in the order given, refusals in place, and only reads', async () => {
    const w = world({ 1: automatic, 3: automatic })
    const planned = await plan([3, 2, 1], w)

    expect(planned.lines.map((line) => [line.documentId, line.verdict.action])).toEqual([
      [3, 'remove'],
      [2, 'refuse'],
      [1, 'remove'],
    ])
    expect(w.reads).toEqual([
      'document 3',
      'placements 3',
      'file 3',
      'document 2',
      'document 1',
      'placements 1',
      'file 1',
    ])
  })
})

describe('doing it', () => {
  it('hands each document the plan said to removeStamp, to Skipped, with the reason', async () => {
    const remove = vi.fn().mockResolvedValue({ placementsRemoved: 2, processedFileRemoved: true })
    const planned = await plan([5765, 5767], world({ 5765: automatic, 5767: automatic }))

    const result = await apply(planned, {
      reason: 'signed by MMC before upload',
      actor,
      context,
      remove,
    })

    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith(automatic.document, actor, context, {
      nextStatus: SIGNATURE_STATUS.SKIPPED,
      source: 'unstamp command',
      reason: 'signed by MMC before upload',
    })
    expect(result.done.map((o) => o.documentId)).toEqual([5765, 5767])
    expect(result.failed).toEqual([])
  })

  it('never touches a refused document', async () => {
    const remove = vi.fn().mockResolvedValue({ placementsRemoved: 1, processedFileRemoved: true })
    const planned = await plan(
      [1, 2],
      world({
        1: automatic,
        2: { ...automatic, placements: [placement('Manual')] },
      }),
    )

    await apply(planned, { reason: 'x', actor, context, remove })

    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe(automatic.document)
  })

  it('reports a failure and carries on with the next', async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ placementsRemoved: 2, processedFileRemoved: true })
    const seen: number[] = []
    const planned = await plan([1, 2], world({ 1: automatic, 2: automatic }))

    const result = await apply(planned, {
      reason: 'x',
      actor,
      context,
      remove,
      onEach: (o) => seen.push(o.documentId),
    })

    expect(result.failed.map((f) => f.documentId)).toEqual([1])
    expect(result.done.map((o) => o.documentId)).toEqual([2])
    expect(seen).toEqual([1, 2])
  })

  it('a dry run is the plan alone: nothing is handed to removeStamp', async () => {
    // The command prints the plan and returns before apply(); this pins that
    // the plan itself writes nothing, whatever it reads.
    const w = world({ 5765: automatic })
    const remove = vi.fn()
    await plan([5765], w)
    expect(remove).not.toHaveBeenCalled()
    expect(w.reads.every((read) => /^(document|placements|file) /.test(read))).toBe(true)
  })
})

describe('the ids on the command line', () => {
  it('reads commas, spaces and lines, each id once, in order', () => {
    expect(parseDocumentIds('5765,5767 5774\n5776,5765')).toEqual([5765, 5767, 5774, 5776])
  })

  it('refuses anything that is not a document id', () => {
    expect(() => parseDocumentIds('5765,abc')).toThrow("'abc' is not a document id")
    expect(() => parseDocumentIds('0')).toThrow("'0' is not a document id")
    expect(() => parseDocumentIds('12.5')).toThrow("'12.5' is not a document id")
  })

  it('is empty for an empty list', () => {
    expect(parseDocumentIds('')).toEqual([])
    expect(parseDocumentIds(' , ')).toEqual([])
  })
})
