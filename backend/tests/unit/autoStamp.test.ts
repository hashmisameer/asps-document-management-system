import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_STATUS,
  SIGNER_ROLES,
  STAMP_OUTCOMES,
  type DocumentTypePlacement,
  type SignerRole,
} from '@asps-dms/shared'
import {
  REASONS,
  decide,
  overlapShare,
  type DecideInput,
} from '../../src/services/autoStamp.service.js'
import type { BoxAssessment, Verdict } from '../../src/services/boxOccupancy.service.js'
import type { StampCheckResult } from '../../src/services/stampCheck.service.js'

/**
 * Stamping on upload: what is stamped, what is left alone, and what HR reads.
 *
 * Every rule the office would argue about is pinned here against plain
 * values: nothing over something already there, nothing without the image it
 * needs, nothing on a file that matched no template or failed its identity
 * check - and the rest stamped anyway, with the document marked for HR
 * whenever anything was left.
 */

const A4 = { pageCount: 1, widthPt: 595, heightPt: 842 }
const TWO_PAGE = { pageCount: 2, widthPt: 595, heightPt: 842 }

let nextId = 1

function templateRow(
  signerRole: SignerRole,
  overrides: Partial<DocumentTypePlacement> = {},
): DocumentTypePlacement {
  return {
    documentTypePlacementId: nextId++,
    documentTypeId: 9,
    signerRole,
    pageNumber: 1,
    x: 0.6,
    y: 0.8,
    width: 0.25,
    height: 0.08,
    pageRotation: 0,
    pageWidthPt: A4.widthPt,
    pageHeightPt: A4.heightPt,
    variant: A4,
    sampleDocumentId: null,
    createdByName: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** What the occupancy check said about the box at this template index. */
function assessed(index: number, row: DocumentTypePlacement, verdict: Verdict): BoxAssessment {
  return {
    label: String(index),
    signerRole: row.signerRole,
    pageNumber: row.pageNumber,
    rect: { x: row.x, y: row.y, width: row.width, height: row.height },
    verdict,
    decidedBy: verdict === 'empty' ? 'none' : 'ink',
    pageKind: 'scanned',
    overlap: { images: 0, coverage: 0 },
    ...(verdict === 'empty' ? {} : { ink: { percent: 6.1, background: 231, cutoff: 191 } }),
    reason: verdict === 'empty' ? 'no image on the box' : 'ink covers 6.1% of the box',
  }
}

/** A stamp-check that matched the A4 variant and found every box as given. */
function checked(
  rows: readonly DocumentTypePlacement[],
  verdicts: readonly Verdict[] = rows.map(() => 'empty'),
): StampCheckResult {
  return {
    documentId: 1,
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    signatureStatus: SIGNATURE_STATUS.PENDING_DETECTION,
    hasProcessedFile: false,
    outcome: 'checked',
    measured: A4,
    variant: A4,
    templatesInShape: 1,
    boxes: rows.map((row, index) => assessed(index, row, verdicts[index] ?? 'empty')),
  }
}

function unmatched(
  outcome: 'noVariant' | 'ambiguousVariant' | 'notPdf' | 'unreadable',
): StampCheckResult {
  return {
    documentId: 1,
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    signatureStatus: SIGNATURE_STATUS.PENDING_DETECTION,
    hasProcessedFile: false,
    outcome,
    measured: null,
    variant: null,
    templatesInShape: 0,
    boxes: [],
  }
}

const everything = { employeeSignature: true, authoriserSignature: true, photo: true }

/** Every type these tests use is in the list unless a test says otherwise. */
const LISTED: ReadonlySet<string> = new Set(['APPOINTMENT_LETTER', 'ESIC_FORM'])

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.AUTHORISER)]
  return {
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    autoStampTypes: LISTED,
    identityCheck: 'Passed',
    templateRows: rows,
    check: checked(rows),
    images: everything,
    existing: [],
    ...overrides,
  }
}

describe('the ordinary case', () => {
  it('stamps every box, and the document is signed', () => {
    const decision = decide(input())

    expect(decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Employee', 'Authoriser'])
    expect(decision.boxes.every((box) => box.reason === null)).toBe(true)
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.ADDED)
    expect(decision.summary).toBe('Stamped: employee signature and hr signature.')
    expect(decision.variant).toEqual(A4)
  })

  it('carries the template box through, so the runner stamps where the template says', () => {
    const decision = decide(input())
    const [employee] = decision.toStamp

    expect(employee?.template.x).toBe(0.6)
    expect(employee?.template.pageNumber).toBe(1)
    expect(employee?.found).toBe('empty')
  })
})

describe('a box that already has something in it', () => {
  it('is left alone, the rest is stamped, and HR is told', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.AUTHORISER)]
    const decision = decide(
      input({ templateRows: rows, check: checked(rows, ['occupied', 'empty']) }),
    )

    expect(decision.outcome).toBe(STAMP_OUTCOMES.PARTIAL)
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Authoriser'])
    expect(decision.boxes[0]).toMatchObject({
      action: 'skip',
      found: 'occupied',
      reason: REASONS.occupied('ink covers 6.1% of the box'),
    })
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(decision.summary).toBe(
      'Stamped: hr signature. Not stamped: the employee signature - the box already has something in it (ink covers 6.1% of the box).',
    )
  })

  it('treats an uncertain box the same way: not guessed at', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE)]
    const decision = decide(input({ templateRows: rows, check: checked(rows, ['uncertain']) }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.NOTHING)
    expect(decision.boxes[0]?.reason).toBe(REASONS.uncertain('ink covers 6.1% of the box'))
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })

  it('leaves alone a box the check did not assess, rather than assuming it empty', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.AUTHORISER)]
    const check = checked(rows)
    check.boxes = check.boxes.slice(0, 1)
    const decision = decide(input({ templateRows: rows, check }))

    expect(decision.boxes[1]).toMatchObject({ action: 'skip', found: null })
  })
})

describe('an image that is not on file', () => {
  it('leaves the HR box empty when the uploader has no signature, and stamps the employee', () => {
    const decision = decide(input({ images: { ...everything, authoriserSignature: false } }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.PARTIAL)
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Employee'])
    expect(decision.boxes[1]?.reason).toBe(REASONS.noAuthoriserSignature)
    // Something is still missing: HR must see it.
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(decision.summary).toBe(
      'Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.',
    )
  })

  it('stamps nothing for an employee with no signature, when that is the only box', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE)]
    const decision = decide(
      input({
        templateRows: rows,
        check: checked(rows),
        images: { ...everything, employeeSignature: false },
      }),
    )

    expect(decision.outcome).toBe(STAMP_OUTCOMES.NOTHING)
    expect(decision.toStamp).toEqual([])
    expect(decision.summary).toBe(
      'Not stamped: the employee signature - the employee has no signature on file.',
    )
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })

  it('says one reason once when two boxes share it', () => {
    const rows = [
      templateRow(SIGNER_ROLES.EMPLOYEE, { pageNumber: 1 }),
      templateRow(SIGNER_ROLES.EMPLOYEE, { pageNumber: 2, variant: TWO_PAGE }),
    ]
    const check = { ...checked(rows), variant: TWO_PAGE, measured: TWO_PAGE }
    const twoPageRows = rows.map((row) => ({ ...row, variant: TWO_PAGE }))
    const decision = decide(
      input({
        templateRows: twoPageRows,
        check: { ...check, boxes: twoPageRows.map((row, i) => assessed(i, row, 'empty')) },
        images: { ...everything, employeeSignature: false },
      }),
    )

    expect(decision.summary).toBe(
      'Not stamped: the employee signature on page 1 and employee signature on page 2 - the employee has no signature on file.',
    )
  })
})

describe('the photograph', () => {
  const esic = (rows: DocumentTypePlacement[], images = everything) =>
    input({
      documentCode: 'ESIC_FORM',
      documentName: 'ESIC Form',
      templateRows: rows,
      check: checked(rows),
      images,
    })

  it('goes on the ESIC form with the signatures', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.PHOTO)]
    const decision = decide(esic(rows))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Employee', 'Photo'])
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.ADDED)
  })

  it('is left out when there is none on file, and the form waits for HR', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.PHOTO)]
    const decision = decide(esic(rows, { ...everything, photo: false }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.PARTIAL)
    expect(decision.boxes[1]?.reason).toBe(REASONS.noPhoto)
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })

  it('never goes on any other form, whatever a template says', () => {
    const rows = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.PHOTO)]
    const decision = decide(input({ templateRows: rows, check: checked(rows) }))

    expect(decision.boxes[1]?.reason).toBe(REASONS.photoElsewhere)
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Employee'])
  })

  it('does not count a photograph alone as a signed document', () => {
    const rows = [templateRow(SIGNER_ROLES.PHOTO)]
    const decision = decide(esic(rows))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })
})

describe('a file that matched nothing', () => {
  it.each([
    ['noVariant', STAMP_OUTCOMES.NO_VARIANT, REASONS.noVariant],
    ['ambiguousVariant', STAMP_OUTCOMES.AMBIGUOUS_VARIANT, REASONS.ambiguousVariant],
    ['notPdf', STAMP_OUTCOMES.NOT_PDF, REASONS.notPdf],
    ['unreadable', STAMP_OUTCOMES.UNREADABLE, REASONS.unreadable],
  ] as const)('%s stamps nothing and says so', (checkOutcome, outcome, reason) => {
    const decision = decide(input({ check: unmatched(checkOutcome) }))

    expect(decision.outcome).toBe(outcome)
    expect(decision.toStamp).toEqual([])
    expect(decision.boxes).toEqual([])
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(decision.summary).toBe(`Not stamped: ${reason}.`)
  })

  it('says a type with no template has no template', () => {
    const decision = decide(input({ templateRows: [], check: null }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.NO_TEMPLATE)
    expect(decision.summary).toBe('Not stamped: Appointment Letter has no template.')
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })
})

describe('the identity check comes first', () => {
  it('stamps nothing on a document that may not be this employee’s, however well it matches', () => {
    const decision = decide(input({ identityCheck: 'Failed' }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.IDENTITY_FAILED)
    expect(decision.toStamp).toEqual([])
    expect(decision.summary).toBe(`Not stamped: ${REASONS.identityFailed}.`)
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })

  it('stamps nothing while the check is still running', () => {
    const decision = decide(input({ identityCheck: 'Checking' }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.FAILED)
    expect(decision.toStamp).toEqual([])
  })

  it.each(['Passed', 'Overridden', 'NotChecked'] as const)('goes ahead after %s', (status) => {
    expect(decide(input({ identityCheck: status })).outcome).toBe(STAMP_OUTCOMES.STAMPED)
  })
})

describe('the variant', () => {
  it('uses the boxes of the variant that matched, not every box of the type', () => {
    const a4 = [templateRow(SIGNER_ROLES.EMPLOYEE), templateRow(SIGNER_ROLES.AUTHORISER)]
    const twoPage = [
      templateRow(SIGNER_ROLES.EMPLOYEE, { pageNumber: 2, variant: TWO_PAGE, x: 0.1 }),
    ]
    const decision = decide(input({ templateRows: [...twoPage, ...a4], check: checked(a4) }))

    expect(decision.boxes).toHaveLength(2)
    expect(decision.boxes.map((box) => box.template.x)).toEqual([0.6, 0.6])
  })

  it('uses the boxes of the one saved template the check chose, not of every template of that shape', () => {
    // Two templates saved under the old exact-size key, one shape: 595x841
    // and 596x842 are both A4. The check chose the 596x842 one; only its
    // rows are stamped. Collecting by the rounded shape key gathered both
    // and a form got two employee signatures.
    const older = { pageCount: 1, widthPt: 595, heightPt: 841 }
    const newer = { pageCount: 1, widthPt: 596, heightPt: 842 }
    const olderRows = [
      templateRow(SIGNER_ROLES.EMPLOYEE, { variant: older, x: 0.1 }),
      templateRow(SIGNER_ROLES.AUTHORISER, { variant: older, x: 0.1 }),
    ]
    const newerRows = [
      templateRow(SIGNER_ROLES.EMPLOYEE, { variant: newer, x: 0.7 }),
      templateRow(SIGNER_ROLES.AUTHORISER, { variant: newer, x: 0.7 }),
    ]
    const check = {
      ...checked(newerRows),
      measured: { pageCount: 1, widthPt: 595, heightPt: 842 },
      variant: newer,
      templatesInShape: 2,
    }

    const decision = decide(input({ templateRows: [...olderRows, ...newerRows], check }))

    expect(decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(decision.boxes).toHaveLength(2)
    expect(decision.boxes.map((box) => box.template.x)).toEqual([0.7, 0.7])
    expect(decision.boxes.filter((box) => box.signerRole === 'Employee')).toHaveLength(1)
    expect(decision.summary).toBe(
      'Stamped: employee signature and hr signature. (2 saved templates are this shape; the newest was used.)',
    )
  })
})

describe('what is already on the document', () => {
  const esicRows = () => [
    templateRow(SIGNER_ROLES.PHOTO, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
    templateRow(SIGNER_ROLES.EMPLOYEE, { x: 0.4, y: 0.8 }),
    templateRow(SIGNER_ROLES.AUTHORISER, { x: 0.7, y: 0.8 }),
  ]
  const esic = (existing: DecideInput['existing'], rows = esicRows()) =>
    input({
      documentCode: 'ESIC_FORM',
      documentName: 'ESIC Form',
      templateRows: rows,
      check: checked(rows),
      existing,
    })
  const byHand = (
    signerRole: SignerRole,
    rect = { x: 0.15, y: 0.15, width: 0.2, height: 0.2 },
    method: 'Manual' | 'Automatic' = 'Manual',
  ) => ({ signerRole, pageNumber: 1, rect, method })

  it('keeps a photograph HR placed by hand and adds the two signatures', () => {
    const decision = decide(esic([byHand(SIGNER_ROLES.PHOTO)]))

    expect(decision.boxes.map((box) => [box.signerRole, box.action])).toEqual([
      ['Photo', 'keep'],
      ['Employee', 'stamp'],
      ['Authoriser', 'stamp'],
    ])
    expect(decision.kept[0]?.reason).toBe('already on the page, placed by hand')
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Employee', 'Authoriser'])
    // Kept is done: the document is complete and signed.
    expect(decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.ADDED)
    expect(decision.summary).toBe(
      'Stamped: employee signature and hr signature. Kept: employee photo (placed by hand).',
    )
  })

  it('never puts a second box of a role already on the page - by hand or by an earlier stamp', () => {
    const decision = decide(
      esic([
        byHand(SIGNER_ROLES.EMPLOYEE, { x: 0.5, y: 0.5, width: 0.2, height: 0.1 }, 'Automatic'),
        byHand(SIGNER_ROLES.PHOTO),
      ]),
    )

    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Authoriser'])
    expect(decision.kept.map((box) => [box.signerRole, box.reason])).toEqual([
      ['Photo', 'already on the page, placed by hand'],
      ['Employee', 'already stamped earlier'],
    ])
    expect(decision.summary).toBe(
      'Stamped: hr signature. Kept: employee photo (placed by hand); employee signature (stamped earlier).',
    )
  })

  it('is by page: a box of the same role on another page does not count', () => {
    const decision = decide(esic([{ ...byHand(SIGNER_ROLES.EMPLOYEE), pageNumber: 2 }]))
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual([
      'Photo',
      'Employee',
      'Authoriser',
    ])
    expect(decision.kept).toEqual([])
  })

  it('a kept signature makes the document complete even when nothing new is a signature', () => {
    const decision = decide(
      esic([
        byHand(SIGNER_ROLES.EMPLOYEE, { x: 0.4, y: 0.8, width: 0.25, height: 0.08 }),
        byHand(SIGNER_ROLES.AUTHORISER, { x: 0.7, y: 0.8, width: 0.25, height: 0.08 }),
      ]),
    )
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Photo'])
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.ADDED)
  })

  it('does not paint a template box over a box HR placed there for another role', () => {
    // HR put the employee signature where the template's photograph goes.
    const decision = decide(
      esic([byHand(SIGNER_ROLES.EMPLOYEE, { x: 0.12, y: 0.12, width: 0.2, height: 0.2 })]),
    )

    const photo = decision.boxes.find((box) => box.signerRole === 'Photo')
    expect(photo?.action).toBe('skip')
    expect(photo?.reason).toBe('it would lie over the employee signature box placed by hand')
    expect(decision.toStamp.map((box) => box.signerRole)).toEqual(['Authoriser'])
    expect(decision.outcome).toBe(STAMP_OUTCOMES.PARTIAL)
  })

  it('lets boxes that merely touch stand side by side', () => {
    // A tenth overlapping is the line: five per cent is a neighbour.
    const decision = decide(
      esic([byHand(SIGNER_ROLES.EMPLOYEE, { x: 0.29, y: 0.1, width: 0.2, height: 0.2 })]),
    )
    expect(decision.boxes.find((box) => box.signerRole === 'Photo')?.action).toBe('stamp')
  })

  it('leaves alone what the template does not know about', () => {
    // A box on page 3, where the template has nothing: not the decision's
    // business; the runner keeps every existing row regardless.
    const decision = decide(esic([{ ...byHand(SIGNER_ROLES.EMPLOYEE), pageNumber: 3 }]))
    expect(decision.boxes).toHaveLength(3)
    expect(decision.boxes.every((box) => box.action === 'stamp')).toBe(true)
  })

  it('changes nothing for a fresh upload', () => {
    const decision = decide(esic([]))
    expect(decision.kept).toEqual([])
    expect(decision.boxes.every((box) => box.action === 'stamp')).toBe(true)
    expect(decision.summary).toBe('Stamped: employee photo, employee signature and hr signature.')
  })
})

describe('overlapShare', () => {
  it('is the share of the first box under the second', () => {
    const box = { x: 0, y: 0, width: 0.2, height: 0.2 }
    expect(overlapShare(box, { x: 0.1, y: 0, width: 0.2, height: 0.2 })).toBeCloseTo(0.5)
    expect(overlapShare(box, { x: 0.2, y: 0, width: 0.2, height: 0.2 })).toBe(0)
    expect(overlapShare(box, { x: 0, y: 0, width: 1, height: 1 })).toBeCloseTo(1)
    expect(overlapShare(box, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })).toBe(0)
  })
})

describe('the auto-stamp list', () => {
  it('leaves a type that is not in the list for HR, before looking at anything else', () => {
    const decision = decide(
      input({
        documentCode: 'PF_FORM',
        documentName: 'PF Form',
        // Even a file that would otherwise fail: the list is first.
        identityCheck: 'Failed',
      }),
    )

    expect(decision.outcome).toBe(STAMP_OUTCOMES.NOT_IN_LIST)
    expect(decision.toStamp).toEqual([])
    expect(decision.boxes).toEqual([])
    expect(decision.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(decision.summary).toBe('Not stamped: PF Form is not in the auto-stamp list.')
  })

  it('stamps nothing at all when the list is empty', () => {
    const decision = decide(input({ autoStampTypes: new Set() }))
    expect(decision.outcome).toBe(STAMP_OUTCOMES.NOT_IN_LIST)
    expect(decision.toStamp).toEqual([])
  })

  it('is matched on the document code exactly', () => {
    expect(decide(input({ autoStampTypes: new Set(['ESIC_FORM']) })).outcome).toBe(
      STAMP_OUTCOMES.NOT_IN_LIST,
    )
    expect(
      decide(input({ documentCode: 'ESIC_FORM', autoStampTypes: new Set(['ESIC_FORM']) })).outcome,
    ).toBe(STAMP_OUTCOMES.STAMPED)
  })
})
