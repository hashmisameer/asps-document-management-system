import type { PDFFont } from 'pdf-lib'
import type { AuthUser, PrintDocumentEmployeesQuery } from '@asps-dms/shared'
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import * as reportRepository from '../repositories/report.repository.js'
import type { DocumentEmployeeRow } from '../repositories/report.repository.js'
import { NotFoundError } from '../utils/errors.js'
import {
  A4_LANDSCAPE,
  DASH,
  HEADER_FILL,
  MUTED,
  ROW_TINT,
  RULE,
  createSheet,
  draw,
  drawFooters,
  drawRight,
  fileNameDate,
  fileNamePart,
  fits,
  formatDate,
  formatTimestamp,
  newPage,
  toBuffer,
  truncate,
  type PrintMeta,
  type Sheet,
} from '../utils/pdfDraw.js'

/**
 * The chase list for one document type, on paper.
 *
 * This is the sheet somebody walks round the factory with, or hands to a
 * department head: who still owes the PF form, which of them are late, and how
 * late. Landscape, because it is a table read across rather than a form read
 * down.
 *
 * THE CSV STAYS. The two are not alternatives - a spreadsheet is forwarded and
 * sorted, and a printed list is carried and ticked - and the office asked for
 * both, so both are offered on the same screen.
 *
 * NO identity numbers and no pay, for the same reason they are kept off the
 * employee form: this leaves the building. What it carries is the least
 * somebody needs in order to go and ask for a document.
 */

const MARGIN = 36

export interface DocumentListReport {
  documentName: string
  /** A type nobody is obliged to send cannot be late, so its rows never read as overdue. */
  tracksOverdue: boolean
  rows: readonly DocumentEmployeeRow[]
  filters: PrintDocumentEmployeesQuery
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The status this list prints for a row.
 *
 * The same reading the screen gives it: a type that is not mandatory has no
 * deadline to miss, so its outstanding rows say Pending however old they are.
 */
export function rowStatus(row: DocumentEmployeeRow, tracksOverdue: boolean): string {
  if (row.state === 'Received') return 'Received'
  return row.state === 'Overdue' && tracksOverdue ? 'Overdue' : 'Pending'
}

/**
 * How long this row has been waiting, in the words the column heading promises.
 *
 * Both directions, because both are worth knowing on a chase list: a document
 * eleven days late is a different conversation from one due in three.
 */
export function rowDays(row: DocumentEmployeeRow, tracksOverdue: boolean): string {
  if (row.state === 'Received' || row.daysOverdue === null) return DASH
  if (row.daysOverdue > 0) return tracksOverdue ? `${row.daysOverdue} overdue` : DASH
  if (row.daysOverdue === 0) return 'due today'
  return `${Math.abs(row.daysOverdue)} to go`
}

/**
 * The one-line summary under the heading.
 *
 * 'PF Form - 41 employees outstanding (34 overdue)'. The counts are of the rows
 * ACTUALLY PRINTED, not of the document type as a whole, so the sentence and
 * the table below it can never disagree.
 */
export function summaryLine(report: DocumentListReport): string {
  const { rows, documentName, tracksOverdue } = report
  const outstanding = rows.filter((row) => row.state !== 'Received').length
  const overdue = tracksOverdue ? rows.filter((row) => row.state === 'Overdue').length : 0

  if (rows.length === 0) return `${documentName} - nobody matches these filters`

  const people = (count: number): string => `${count} ${count === 1 ? 'employee' : 'employees'}`

  // When employees who have already sent it are included, 'outstanding' would
  // be the wrong word for the whole list, so the count says both.
  const body = report.filters.outstandingOnly
    ? `${people(outstanding)} outstanding`
    : `${people(rows.length)}, ${outstanding} outstanding`

  return `${documentName} - ${body}${overdue > 0 ? ` (${overdue} overdue)` : ''}`
}

/**
 * What was filtered, said plainly on the paper.
 *
 * A list of 12 people looks exactly like a list of everybody, and a department
 * head who is not told this is only CUTTING will read it as the whole factory.
 */
export function filterLine(filters: PrintDocumentEmployeesQuery): string {
  const parts = [filters.department ? `Department: ${filters.department}` : 'All departments']

  if (filters.onlyOverdue) parts.push('Overdue only')
  else if (filters.outstandingOnly) parts.push('Outstanding only')
  else parts.push('Including those who have sent it')

  // Not a filter, but the same kind of fact about what this sheet is: it never
  // holds anybody who has left.
  parts.push('Current employees only')

  return parts.join('  ·  ')
}

/** 'PF_Form_pending_2026-09-03.pdf'. */
export function listFileName(
  documentName: string,
  filters: PrintDocumentEmployeesQuery,
  generatedAt: Date,
): string {
  const which = filters.onlyOverdue ? 'overdue' : filters.outstandingOnly ? 'pending' : 'all'
  const stem = fileNamePart(documentName) || 'Document'
  return `${stem}_${which}_${fileNameDate(generatedAt)}.pdf`
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/** Column widths, left to right. They add up to the landscape content width. */
const COLUMNS = [
  { title: 'Employee ID', width: 88, align: 'left' },
  { title: 'Name', width: 196, align: 'left' },
  { title: 'Department', width: 136, align: 'left' },
  { title: 'Designation', width: 146, align: 'left' },
  { title: 'Status', width: 66, align: 'left' },
  { title: 'Due date', width: 72, align: 'left' },
  { title: 'Days', width: 65.89, align: 'right' },
] as const

const HEADER_HEIGHT = 16
const ROW_HEIGHT = 15.5

function columnX(sheet: Sheet, index: number): number {
  let x = sheet.margin
  for (let i = 0; i < index; i += 1) x += COLUMNS[i]?.width ?? 0
  return x
}

function drawTableHeader(sheet: Sheet): void {
  sheet.page.drawRectangle({
    x: sheet.margin,
    y: sheet.y - HEADER_HEIGHT,
    width: sheet.contentWidth,
    height: HEADER_HEIGHT,
    color: HEADER_FILL,
  })

  COLUMNS.forEach((column, index) => {
    const y = sheet.y - HEADER_HEIGHT + 5.5
    const title = column.title.toUpperCase()
    if (column.align === 'right') {
      drawRight(sheet.page, title, {
        right: columnX(sheet, index) + column.width - 6,
        y,
        font: sheet.fonts.bold,
        size: 7.5,
        color: MUTED,
      })
    } else {
      draw(sheet.page, title, {
        x: columnX(sheet, index) + 6,
        y,
        font: sheet.fonts.bold,
        size: 7.5,
        color: MUTED,
      })
    }
  })

  sheet.y -= HEADER_HEIGHT
}

/**
 * The heading block: what this list is, what it adds up to, and when it was taken.
 *
 * Drawn on the first page in full and repeated in one line at the top of every
 * continuation, because a page 7 that does not say which document it is about
 * is a page nobody can file.
 */
function drawHeading(sheet: Sheet, report: DocumentListReport, meta: PrintMeta): void {
  const top = sheet.y

  draw(sheet.page, report.documentName, {
    x: sheet.margin,
    y: top - 15,
    font: sheet.fonts.bold,
    size: 16,
  })
  drawRight(sheet.page, `Generated ${formatTimestamp(meta.generatedAt)}`, {
    right: sheet.margin + sheet.contentWidth,
    y: top - 14,
    font: sheet.fonts.regular,
    size: 9,
    color: MUTED,
  })

  draw(sheet.page, summaryLine(report), {
    x: sheet.margin,
    y: top - 32,
    font: sheet.fonts.bold,
    size: 11,
  })
  draw(sheet.page, filterLine(report.filters), {
    x: sheet.margin,
    y: top - 46,
    font: sheet.fonts.regular,
    size: 8.5,
    color: MUTED,
  })

  sheet.y = top - 58
}

function drawContinuationHeading(sheet: Sheet, report: DocumentListReport): void {
  draw(sheet.page, `${report.documentName} (continued)`, {
    x: sheet.margin,
    y: sheet.y - 11,
    font: sheet.fonts.bold,
    size: 10,
    color: MUTED,
  })
  sheet.y -= 20
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export async function renderDocumentList(
  report: DocumentListReport,
  meta: PrintMeta,
): Promise<Buffer> {
  const sheet = await createSheet({ size: A4_LANDSCAPE, margin: MARGIN, footerSpace: 34 })

  sheet.pdf.setTitle(`${report.documentName} - outstanding`)
  sheet.pdf.setCreator('ASPS Document Management System')
  sheet.pdf.setProducer('ASPS Document Management System')
  sheet.pdf.setCreationDate(meta.generatedAt)

  drawHeading(sheet, report, meta)

  if (report.rows.length === 0) {
    draw(sheet.page, 'Nobody matches these filters.', {
      x: sheet.margin,
      y: sheet.y - 12,
      font: sheet.fonts.regular,
      size: 10,
    })
    drawFooters(sheet, meta)
    return toBuffer(sheet)
  }

  drawTableHeader(sheet)

  for (const row of report.rows) {
    if (!fits(sheet, ROW_HEIGHT)) {
      newPage(sheet)
      drawContinuationHeading(sheet, report)
      // The column headings go again at the top of every page: a column of
      // dates with nothing saying which date they are is no use to anybody.
      drawTableHeader(sheet)
    }

    const status = rowStatus(row, report.tracksOverdue)
    const bottom = sheet.y - ROW_HEIGHT

    // Late rows are tinted rather than coloured, so they survive the office
    // photocopier, which is where most of these end up.
    if (status === 'Overdue') {
      sheet.page.drawRectangle({
        x: sheet.margin,
        y: bottom,
        width: sheet.contentWidth,
        height: ROW_HEIGHT,
        color: ROW_TINT,
      })
    }

    const emphasis: PDFFont = status === 'Received' ? sheet.fonts.regular : sheet.fonts.bold
    const cells: { text: string; font: PDFFont }[] = [
      { text: row.employeeCode, font: sheet.fonts.regular },
      { text: row.employeeName, font: sheet.fonts.regular },
      { text: row.department ?? DASH, font: sheet.fonts.regular },
      { text: row.designation ?? DASH, font: sheet.fonts.regular },
      { text: status, font: emphasis },
      { text: formatDate(row.dueDate), font: sheet.fonts.regular },
      { text: rowDays(row, report.tracksOverdue), font: emphasis },
    ]

    cells.forEach((cell, index) => {
      const column = COLUMNS[index]
      if (!column) return
      // Cut rather than wrapped: one employee to a line is what makes a list of
      // three hundred countable by eye and tickable by pen.
      const text = truncate(cell.text, cell.font, 9, column.width - 12)
      if (column.align === 'right') {
        drawRight(sheet.page, text, {
          right: columnX(sheet, index) + column.width - 6,
          y: bottom + 4.8,
          font: cell.font,
          size: 9,
        })
      } else {
        draw(sheet.page, text, {
          x: columnX(sheet, index) + 6,
          y: bottom + 4.8,
          font: cell.font,
          size: 9,
        })
      }
    })

    sheet.page.drawLine({
      start: { x: sheet.margin, y: bottom },
      end: { x: sheet.margin + sheet.contentWidth, y: bottom },
      thickness: 0.5,
      color: RULE,
    })

    sheet.y = bottom
  }

  drawFooters(sheet, meta)
  return toBuffer(sheet)
}

/**
 * Reads the list and renders it.
 *
 * The rows come from the report repository's UNPAGED query, with the filters
 * and the sort exactly as the screen had them - so what prints is what was
 * being looked at, all of it, in the same order.
 */
export async function printDocumentList(
  documentTypeId: number,
  filters: PrintDocumentEmployeesQuery,
  actor: AuthUser,
): Promise<{ fileName: string; pdf: Buffer }> {
  const type = await documentTypeRepository.findById(documentTypeId)
  if (!type) throw new NotFoundError('That document type does not exist.')

  const rows = await reportRepository.allEmployeesForDocumentType({ ...filters, documentTypeId })

  const generatedAt = new Date()
  const pdf = await renderDocumentList(
    {
      documentName: type.documentName,
      tracksOverdue: type.isMandatory,
      rows,
      filters,
    },
    { generatedAt, generatedBy: actor.fullName },
  )

  return { fileName: listFileName(type.documentName, filters, generatedAt), pdf }
}
