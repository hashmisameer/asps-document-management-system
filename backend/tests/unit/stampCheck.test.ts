import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { toPdfUserSpace, type DocumentTypePlacement, type NormalizedRect } from '@asps-dms/shared'
import type { StampCheckCandidate } from '../../src/repositories/employeeDocument.repository.js'
import {
  inkFraction,
  settingsFromEnv,
  toGrey,
  type OccupancySettings,
} from '../../src/services/boxOccupancy.service.js'
import {
  checkDocument,
  formatResult,
  formatSummary,
  summarise,
  variantsOf,
  type StampCheckResult,
} from '../../src/services/stampCheck.service.js'

/**
 * The stamp-check report.
 *
 * Real PDFs, so the variant is measured the way the template editor measures
 * it and the boxes are assessed by the real rule. What is asserted: the right
 * template variant is chosen (and none is guessed), the numbers come through
 * for printing, and the printout carries document ids and types and nothing
 * that names a person.
 */

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const BOX: NormalizedRect = { x: 0.6, y: 0.8, width: 0.28, height: 0.09 }

const SETTINGS: OccupancySettings = {
  fullPageMin: 0.5,
  overlapMin: 0.25,
  inkEmptyMax: 0.015,
  inkOccupiedMin: 0.035,
  inkMargin: 40,
  inkCutoffCeiling: 200,
}

async function jpeg(width: number, height: number, grey: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } } })
    .jpeg({ quality: 95 })
    .toBuffer()
}

async function makePdf(options: { pages?: number; imageOnBox?: boolean; scan?: number } = {}) {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < (options.pages ?? 1); i += 1) pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const page = pdf.getPage(0)
  if (options.scan !== undefined) {
    const picture = await pdf.embedJpg(await jpeg(PAGE_WIDTH, PAGE_HEIGHT, options.scan))
    page.drawImage(picture, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
  }
  if (options.imageOnBox) {
    const stamp = await pdf.embedJpg(await jpeg(300, 100, 30))
    const target = toPdfUserSpace(BOX, PAGE_WIDTH, PAGE_HEIGHT, 0)
    page.drawImage(stamp, { x: target.x, y: target.y, width: target.width, height: target.height })
  }
  return Buffer.from(await pdf.save())
}

function templateRow(
  variant: { pageCount: number; widthPt: number; heightPt: number },
  overrides: Partial<DocumentTypePlacement> = {},
): DocumentTypePlacement {
  return {
    documentTypePlacementId: 1,
    documentTypeId: 9,
    signerRole: 'Employee',
    pageNumber: 1,
    x: BOX.x,
    y: BOX.y,
    width: BOX.width,
    height: BOX.height,
    pageRotation: 0,
    pageWidthPt: variant.widthPt,
    pageHeightPt: variant.heightPt,
    variant,
    sampleDocumentId: null,
    createdByName: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const A4_ONE = { pageCount: 1, widthPt: 595, heightPt: 842 }
const A4_TWO = { pageCount: 2, widthPt: 595, heightPt: 842 }

const candidate: StampCheckCandidate = {
  documentId: 77,
  documentTypeId: 9,
  documentCode: 'PF_FORM',
  documentName: 'PF Form / Form 11',
  mimeType: 'application/pdf',
  pageCount: 1,
  signatureStatus: 'ReviewRequired',
  hasProcessedFile: false,
  originalFilePath: 'documents/42/x.pdf',
}

const readFileOf = (bytes: Buffer) => async () => bytes

describe('checkDocument', () => {
  it('measures the document and assesses the matching variant\'s boxes', async () => {
    const result = await checkDocument(
      candidate,
      [templateRow(A4_ONE), templateRow(A4_TWO, { documentTypePlacementId: 2, pageNumber: 2 })],
      { settings: SETTINGS, readFile: readFileOf(await makePdf({ imageOnBox: true })) },
    )

    expect(result.outcome).toBe('checked')
    expect(result.measured).toEqual(A4_ONE)
    expect(result.variant).toEqual(A4_ONE)
    // Only the one-page variant's box - not the two-page form's page-2 box.
    expect(result.boxes).toHaveLength(1)
    expect(result.boxes[0]).toMatchObject({ verdict: 'occupied', decidedBy: 'image', pageNumber: 1 })
  })

  it('carries the fixed cut-offs alongside the real measurement on a scan', async () => {
    const result = await checkDocument(candidate, [templateRow(A4_ONE)], {
      settings: SETTINGS,
      compareCutoffs: [128, 160, 200],
      readFile: readFileOf(await makePdf({ scan: 235 })),
    })

    expect(result.outcome).toBe('checked')
    const box = result.boxes[0]
    expect(box?.verdict).toBe('empty')
    expect(box?.ink?.background).toBe(235)
    expect(box?.ink?.atCutoff?.map((at) => at.cutoff)).toEqual([128, 160, 200])
    for (const at of box?.ink?.atCutoff ?? []) expect(at.percent).toBe(0)
  })

  it('does not guess when no template is the document\'s form', async () => {
    const result = await checkDocument(candidate, [templateRow(A4_TWO)], {
      settings: SETTINGS,
      readFile: readFileOf(await makePdf({ pages: 1 })),
    })

    expect(result.outcome).toBe('noVariant')
    expect(result.measured).toEqual(A4_ONE)
    expect(result.boxes).toEqual([])
    expect(result.detail).toContain('A4 portrait, 2 pages')
  })

  it('reports a document two templates claim, and assesses neither', async () => {
    // Two variants a point apart both match within the slack.
    const rows = [
      templateRow(A4_ONE),
      templateRow({ pageCount: 1, widthPt: 596, heightPt: 842 }, { documentTypePlacementId: 2 }),
    ]
    const result = await checkDocument(candidate, rows, {
      settings: SETTINGS,
      readFile: readFileOf(await makePdf()),
    })

    expect(result.outcome).toBe('ambiguousVariant')
    expect(result.boxes).toEqual([])
  })

  it('does not open an image upload against a template', async () => {
    let read = 0
    const result = await checkDocument(
      { ...candidate, mimeType: 'image/jpeg' },
      [templateRow(A4_ONE)],
      {
        settings: SETTINGS,
        readFile: async () => {
          read += 1
          return Buffer.alloc(0)
        },
      },
    )
    expect(result.outcome).toBe('notPdf')
    expect(read).toBe(0)
  })

  it('reports a file that cannot be read rather than stopping the run', async () => {
    const result = await checkDocument(candidate, [templateRow(A4_ONE)], {
      settings: SETTINGS,
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    })
    expect(result.outcome).toBe('unreadable')
    expect(result.detail).toContain('ENOENT')
  })
})

describe('the comparison cut-offs', () => {
  it('are measured only when asked for, and never by the environment', async () => {
    const grey = await toGrey(await jpeg(100, 100, 235))
    const box = { x: 0, y: 0, width: 1, height: 1 }

    expect(inkFraction(grey, box, SETTINGS).atCutoff).toBeUndefined()
    expect(settingsFromEnv().compareCutoffs).toBeUndefined()

    const with3 = inkFraction(grey, box, { ...SETTINGS, compareCutoffs: [128, 160, 250] })
    expect(with3.atCutoff).toEqual([
      { cutoff: 128, percent: 0 },
      { cutoff: 160, percent: 0 },
      { cutoff: 250, percent: 100 },
    ])
    // The verdict's own number is untouched by the comparison.
    expect(with3.percent).toBe(0)
    expect(with3.cutoff).toBe(195)
  })
})

describe('variantsOf', () => {
  it('lists each variant once however many boxes it has', () => {
    const rows = [
      templateRow(A4_ONE),
      templateRow(A4_ONE, { documentTypePlacementId: 2, signerRole: 'Authoriser' }),
      templateRow(A4_TWO, { documentTypePlacementId: 3 }),
    ]
    expect(variantsOf(rows)).toEqual([A4_ONE, A4_TWO])
  })
})

describe('printing', () => {
  const checked: StampCheckResult = {
    documentId: 77,
    documentCode: 'PF_FORM',
    documentName: 'PF Form / Form 11',
    signatureStatus: 'Added',
    hasProcessedFile: true,
    outcome: 'checked',
    measured: A4_ONE,
    variant: A4_ONE,
    boxes: [
      {
        label: '0',
        signerRole: 'Employee',
        pageNumber: 1,
        rect: BOX,
        verdict: 'occupied',
        decidedBy: 'ink',
        pageKind: 'scanned',
        overlap: { images: 0, coverage: 0 },
        ink: {
          percent: 6.126,
          background: 231,
          cutoff: 191,
          atCutoff: [
            { cutoff: 128, percent: 4.5 },
            { cutoff: 160, percent: 5.75 },
          ],
        },
        reason: '6.13% ink against a background of 231 (cut-off 191)',
      },
    ],
  }

  it('prints the document id, type, status and every number', () => {
    const lines = formatResult(checked)
    expect(lines[0]).toBe('#77  PF Form / Form 11 [PF_FORM]  (Added, has signed copy)  A4 portrait, 1 page')
    expect(lines[1]).toContain('Employee   p1')
    expect(lines[1]).toContain('occupied  by ink   scanned')
    expect(lines[1]).toContain('ink 6.13% (bg 231, cut 191)')
    expect(lines[1]).toContain('fixed @128 4.50% @160 5.75%')
  })

  it('names no employee: the result has nowhere to carry one', () => {
    // The type is the guarantee; this pins it so a field added later shows up here.
    const fields = Object.keys(checked).sort()
    expect(fields).toEqual([
      'boxes',
      'documentCode',
      'documentId',
      'documentName',
      'hasProcessedFile',
      'measured',
      'outcome',
      'signatureStatus',
      'variant',
    ])
    const text = [...formatResult(checked), ...formatSummary(summarise([checked]), SETTINGS)].join('\n')
    expect(text).not.toMatch(/employee(Id|Code|Name)/i)
  })

  it('says why a document was not checked', () => {
    const lines = formatResult({
      ...checked,
      outcome: 'noVariant',
      variant: null,
      boxes: [],
      detail: 'templates: A4 portrait, 2 pages',
    })
    expect(lines[0]).toContain('is A4 portrait, 1 page')
    expect(lines[1]).toBe('    no template for this form: templates: A4 portrait, 2 pages')
  })

  it('counts verdicts per type and lists the documents that disagree with their status', () => {
    const unsignedOccupied: StampCheckResult = {
      ...checked,
      documentId: 78,
      signatureStatus: 'ReviewRequired',
      hasProcessedFile: false,
    }
    const signedEmpty: StampCheckResult = {
      ...checked,
      documentId: 79,
      boxes: [{ ...checked.boxes[0]!, verdict: 'empty', decidedBy: 'none' }],
    }
    const undecided: StampCheckResult = {
      ...checked,
      documentId: 80,
      documentCode: 'ESIC_FORM',
      documentName: 'ESIC Form',
      boxes: [{ ...checked.boxes[0]!, verdict: 'uncertain' }],
    }
    const skipped: StampCheckResult = { ...checked, documentId: 81, outcome: 'notPdf', boxes: [] }

    const summary = summarise([checked, unsignedOccupied, signedEmpty, undecided, skipped])

    expect(summary.byType).toEqual([
      { documentName: 'PF Form / Form 11', documentCode: 'PF_FORM', documents: 3, empty: 1, occupied: 2, uncertain: 0 },
      { documentName: 'ESIC Form', documentCode: 'ESIC_FORM', documents: 1, empty: 0, occupied: 0, uncertain: 1 },
    ])
    expect(summary.byOutcome).toMatchObject({ checked: 4, notPdf: 1 })
    expect(summary.signedButEmpty).toEqual([79])
    expect(summary.unsignedButOccupied).toEqual([78])
    expect(summary.uncertain).toEqual([80])

    const text = formatSummary(summary, SETTINGS).join('\n')
    expect(text).toContain('Signed copy exists but a box reads EMPTY (1):\n    #79')
    expect(text).toContain('No signed copy but a box reads OCCUPIED (1):\n    #78')
    expect(text).toContain('not a PDF')
  })
})
