import { PDFDocument, type PDFPage } from 'pdf-lib'
import sharp from 'sharp'
import { EMPLOYMENT_STATUSES, type EmployeeProfile } from '@asps-dms/shared'
import { logger } from '../utils/logger.js'
import {
  A4_PORTRAIT,
  DASH,
  MUTED,
  RULE,
  createSheet,
  draw,
  drawRight,
  fileNamePart,
  formatDate,
  formatTimestamp,
  newPage,
  rule,
  toBuffer,
  truncate,
  wrap,
  type PrintMeta,
  type Sheet,
} from '../utils/pdfDraw.js'

/**
 * Every document one employee has actually sent in, as a single PDF.
 *
 * What this is for: somebody asks for an employee's file - an inspector, an
 * auditor, the employee themselves - and the answer has been to download ten
 * documents one at a time and hope they arrive in a sensible order. This is
 * that file, in the order the checklist keeps them, with a page before each one
 * saying what it is.
 *
 * THE DOCUMENTS THEMSELVES ARE REPRODUCED UNTOUCHED. No page number, no
 * footer, nothing stamped across somebody's scanned Aadhaar card: a document in
 * this bundle is the document as it was filed. Everything this adds - the
 * cover, the separators - is on pages of its own.
 *
 * The SIGNED copy is taken where there is one, exactly as downloading a single
 * document does, so a bundle shows the signatures the office actually holds.
 */

const MARGIN = 42

export interface BundleFile {
  data: Buffer
  mimeType: string
  /** The processed copy, which carries the signatures. Always a PDF. */
  isSigned: boolean
}

export interface BundleEntry {
  documentName: string
  isMandatory: boolean
  uploadedAt: string | null
  uploadedByName: string | null
  file: BundleFile
}

export interface DocumentBundle {
  employee: EmployeeProfile
  /** In the checklist's own order, and only the ones with a file. */
  included: readonly BundleEntry[]
  /** Named on the cover so the bundle says what is NOT in it. */
  pending: readonly { documentName: string; isMandatory: boolean }[]
}

/** 'EMP-1010_BHAGWAN_SINGH_DOCUMENTS.pdf'. */
export function bundleFileName(employee: {
  employeeCode: string
  employeeName: string
}): string {
  const stem = [
    fileNamePart(employee.employeeCode.toUpperCase()),
    fileNamePart(employee.employeeName.toUpperCase()),
  ]
    .filter(Boolean)
    .join('_')

  return `${stem || 'EMPLOYEE'}_DOCUMENTS.pdf`
}

/* -------------------------------------------------------------------------- */
/* The pages this adds                                                         */
/* -------------------------------------------------------------------------- */

function label(sheet: Sheet, text: string, y: number): void {
  draw(sheet.page, text.toUpperCase(), {
    x: sheet.margin,
    y,
    font: sheet.fonts.regular,
    size: 7,
    color: MUTED,
  })
}

/**
 * The cover: who this is, what is inside, and what is missing.
 *
 * The missing half matters as much as the present one. A bundle that lists
 * only what it contains reads as complete, and somebody receiving eight
 * documents has no way to know the company holds eight of ten.
 */
function drawCover(sheet: Sheet, bundle: DocumentBundle, meta: PrintMeta): void {
  const { employee, included, pending } = bundle
  const top = sheet.y

  draw(sheet.page, 'ASPS International LLP', {
    x: sheet.margin,
    y: top - 15,
    font: sheet.fonts.bold,
    size: 16,
  })
  draw(sheet.page, 'Employee document file', {
    x: sheet.margin,
    y: top - 31,
    font: sheet.fonts.regular,
    size: 10,
    color: MUTED,
  })

  sheet.y = top - 40
  rule(sheet, 8, 6)

  const orDash = (value: string | null): string =>
    value === null || value.trim() === '' ? DASH : value

  const details: [string, string][] = [
    ['Employee ID', employee.employeeCode],
    ['Employee name', employee.employeeName],
    ['Department', orDash(employee.department)],
    ['Designation', orDash(employee.designation)],
    ['Joining date', formatDate(employee.joiningDate)],
    [
      'Employment status',
      employee.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? 'Left' : 'Active',
    ],
  ]

  const columnWidth = (sheet.contentWidth - 18) / 2
  details.forEach(([name, value], index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    const x = sheet.margin + (column === 1 ? columnWidth + 18 : 0)
    const y = sheet.y - 12 - row * 28

    draw(sheet.page, name.toUpperCase(), {
      x,
      y,
      font: sheet.fonts.regular,
      size: 7,
      color: MUTED,
    })
    draw(sheet.page, truncate(value, sheet.fonts.regular, 9.5, columnWidth), {
      x,
      y: y - 12,
      font: sheet.fonts.regular,
      size: 9.5,
    })
  })

  sheet.y -= 12 + Math.ceil(details.length / 2) * 28

  // What is in the file.
  sheet.y -= 10
  label(sheet, `In this file (${included.length})`, sheet.y)
  sheet.y -= 6

  included.forEach((entry, index) => {
    sheet.y -= 14
    draw(sheet.page, `${index + 1}.`, {
      x: sheet.margin,
      y: sheet.y,
      font: sheet.fonts.regular,
      size: 9,
      color: MUTED,
    })
    draw(sheet.page, truncate(entry.documentName, sheet.fonts.regular, 9.5, 260), {
      x: sheet.margin + 18,
      y: sheet.y,
      font: sheet.fonts.regular,
      size: 9.5,
    })
    drawRight(
      sheet.page,
      entry.uploadedAt ? `received ${formatDate(entry.uploadedAt)}` : 'received',
      {
        right: sheet.margin + sheet.contentWidth,
        y: sheet.y,
        font: sheet.fonts.regular,
        size: 9,
        color: MUTED,
      },
    )
  })

  if (pending.length > 0) {
    sheet.y -= 22
    label(sheet, `Not yet received (${pending.length})`, sheet.y)
    sheet.y -= 6

    for (const entry of pending) {
      sheet.y -= 14
      draw(
        sheet.page,
        `${entry.documentName}${entry.isMandatory ? '  (mandatory)' : ''}`,
        { x: sheet.margin + 18, y: sheet.y, font: sheet.fonts.regular, size: 9.5, color: MUTED },
      )
    }
  }

  sheet.y -= 24
  draw(
    sheet.page,
    `${included.length} of ${included.length + pending.length} documents are in this file.`,
    { x: sheet.margin, y: sheet.y, font: sheet.fonts.bold, size: 10 },
  )

  sheet.y -= 16
  draw(sheet.page, `Prepared ${formatTimestamp(meta.generatedAt)} by ${meta.generatedBy}`, {
    x: sheet.margin,
    y: sheet.y,
    font: sheet.fonts.regular,
    size: 8.5,
    color: MUTED,
  })
}

/**
 * The page before each document.
 *
 * Its whole job is to answer 'where does this one start' when somebody is
 * scrolling or has printed the lot, so the name is set large and everything
 * else sits under it.
 */
function drawSeparator(
  sheet: Sheet,
  entry: BundleEntry,
  position: { index: number; total: number },
  problem?: string,
): void {
  newPage(sheet)
  const top = sheet.y

  draw(sheet.page, `Document ${position.index} of ${position.total}`, {
    x: sheet.margin,
    y: top - 12,
    font: sheet.fonts.regular,
    size: 9,
    color: MUTED,
  })

  const lines = wrap(entry.documentName, sheet.fonts.bold, 22, sheet.contentWidth)
  lines.forEach((line, index) => {
    draw(sheet.page, line, {
      x: sheet.margin,
      y: top - 42 - index * 26,
      font: sheet.fonts.bold,
      size: 22,
    })
  })

  sheet.y = top - 42 - lines.length * 26
  rule(sheet, 12, 14)

  const facts: string[] = [
    entry.uploadedAt ? `Received ${formatDate(entry.uploadedAt)}` : 'Received',
    entry.uploadedByName ? `Uploaded by ${entry.uploadedByName}` : '',
    // Which copy is in the bundle. A signed document and the original it was
    // made from are different pieces of paper, and somebody reading this file
    // is entitled to know which one they are looking at.
    entry.file.isSigned ? 'Signed copy' : 'As it was uploaded',
  ].filter(Boolean)

  for (const fact of facts) {
    draw(sheet.page, fact, {
      x: sheet.margin,
      y: sheet.y,
      font: sheet.fonts.regular,
      size: 10,
    })
    sheet.y -= 15
  }

  if (problem) {
    sheet.y -= 10
    for (const line of wrap(problem, sheet.fonts.bold, 10, sheet.contentWidth)) {
      draw(sheet.page, line, { x: sheet.margin, y: sheet.y, font: sheet.fonts.bold, size: 10 })
      sheet.y -= 14
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The documents themselves                                                    */
/* -------------------------------------------------------------------------- */

/** PNG and JPEG go in as they are; anything else is converted rather than refused. */
async function asEmbeddable(file: BundleFile): Promise<{ data: Buffer; kind: 'png' | 'jpg' }> {
  if (file.mimeType === 'image/png') return { data: file.data, kind: 'png' }
  if (file.mimeType === 'image/jpeg') return { data: file.data, kind: 'jpg' }

  // WEBP and TIFF are both accepted uploads and neither can be embedded in a
  // PDF. sharp is already here for the identity check, and a conversion is
  // better than telling somebody their document cannot be included.
  return { data: await sharp(file.data).png().toBuffer(), kind: 'png' }
}

/**
 * One image, on a page of its own.
 *
 * Fitted to A4 rather than given a page its own size, so a bundle of a PDF
 * form and three phone photographs prints on one stack of paper.
 */
async function addImagePage(sheet: Sheet, file: BundleFile): Promise<void> {
  const { data, kind } = await asEmbeddable(file)
  const image = kind === 'png' ? await sheet.pdf.embedPng(data) : await sheet.pdf.embedJpg(data)

  const page = sheet.pdf.addPage([A4_PORTRAIT.width, A4_PORTRAIT.height])
  const maxWidth = A4_PORTRAIT.width - MARGIN * 2
  const maxHeight = A4_PORTRAIT.height - MARGIN * 2
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)

  const width = image.width * scale
  const height = image.height * scale
  page.drawImage(image, {
    x: (A4_PORTRAIT.width - width) / 2,
    y: (A4_PORTRAIT.height - height) / 2,
    width,
    height,
  })
}

/** Every page of a filed PDF, copied in as it stands. */
async function addPdfPages(sheet: Sheet, file: BundleFile): Promise<number> {
  // A scan produced by a photocopier is sometimes 'encrypted' with an empty
  // owner password, which stops nothing and would otherwise stop this.
  const source = await PDFDocument.load(file.data, { ignoreEncryption: true })
  const pages: PDFPage[] = await sheet.pdf.copyPages(source, source.getPageIndices())

  for (const page of pages) sheet.pdf.addPage(page)
  return pages.length
}

/* -------------------------------------------------------------------------- */
/* The bundle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The footer, on the pages this file made and on no others.
 *
 * A document in the bundle is the document as it was filed - stamping a page
 * number across somebody's scanned card would change what the office is
 * holding out as a copy of it.
 */
function drawOwnFooters(sheet: Sheet, ownPages: ReadonlySet<number>, meta: PrintMeta): void {
  const pages = sheet.pdf.getPages()
  const right = sheet.margin + sheet.contentWidth

  pages.forEach((page, index) => {
    if (!ownPages.has(index)) return

    page.drawLine({
      start: { x: sheet.margin, y: sheet.margin + 20 },
      end: { x: right, y: sheet.margin + 20 },
      thickness: 0.5,
      color: RULE,
    })
    draw(page, `Generated ${formatTimestamp(meta.generatedAt)} by ${meta.generatedBy}`, {
      x: sheet.margin,
      y: sheet.margin + 8,
      font: sheet.fonts.regular,
      size: 8,
      color: MUTED,
    })
    drawRight(page, `Page ${index + 1} of ${pages.length}`, {
      right,
      y: sheet.margin + 8,
      font: sheet.fonts.regular,
      size: 8,
      color: MUTED,
    })
  })
}

export async function renderDocumentBundle(
  bundle: DocumentBundle,
  meta: PrintMeta,
): Promise<Buffer> {
  const sheet = await createSheet({ size: A4_PORTRAIT, margin: MARGIN })

  sheet.pdf.setTitle(
    `${bundle.employee.employeeCode} - ${bundle.employee.employeeName} - documents`,
  )
  sheet.pdf.setCreator('ASPS Document Management System')
  sheet.pdf.setProducer('ASPS Document Management System')
  sheet.pdf.setCreationDate(meta.generatedAt)

  const ownPages = new Set<number>([0])
  drawCover(sheet, bundle, meta)

  for (const [index, entry] of bundle.included.entries()) {
    let problem: string | undefined
    let pages: (() => Promise<void>) | undefined

    if (entry.file.mimeType === 'application/pdf') {
      pages = async () => {
        await addPdfPages(sheet, entry.file)
      }
    } else if (entry.file.mimeType.startsWith('image/')) {
      pages = async () => addImagePage(sheet, entry.file)
    } else {
      problem = `This document is a ${entry.file.mimeType} file and could not be included. Download it on its own.`
    }

    drawSeparator(sheet, entry, { index: index + 1, total: bundle.included.length }, problem)
    ownPages.add(sheet.pdf.getPageCount() - 1)

    if (!pages) continue

    try {
      await pages()
    } catch (error) {
      // One unreadable file does not lose the other nine. The separator has
      // already been written, so the bundle still accounts for every document;
      // this only adds why its pages are not behind it.
      logger.warn(
        { err: error, documentName: entry.documentName },
        'A document could not be added to the bundle',
      )
      const page = sheet.pdf.addPage([A4_PORTRAIT.width, A4_PORTRAIT.height])
      ownPages.add(sheet.pdf.getPageCount() - 1)
      draw(page, 'This document could not be read, and is not in this file.', {
        x: MARGIN,
        y: A4_PORTRAIT.height - MARGIN - 20,
        font: sheet.fonts.bold,
        size: 11,
      })
      draw(page, 'Download it on its own to see what is wrong with it.', {
        x: MARGIN,
        y: A4_PORTRAIT.height - MARGIN - 38,
        font: sheet.fonts.regular,
        size: 10,
        color: MUTED,
      })
    }
  }

  drawOwnFooters(sheet, ownPages, meta)
  return toBuffer(sheet)
}
