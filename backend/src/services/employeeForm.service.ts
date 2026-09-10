import { type PDFDocument, type PDFFont, type PDFImage } from 'pdf-lib'
import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  EMPLOYMENT_STATUSES,
  EXIT_REASON_LABEL,
  type EmployeeDocument,
  type EmployeeProfile,
} from '@asps-dms/shared'
import { logger } from '../utils/logger.js'
import {
  appendDocuments,
  drawOwnFooters,
  type DocumentEntry,
} from './documentPages.service.js'
import {
  A4_PORTRAIT,
  DASH,
  HEADER_FILL,
  MUTED,
  ROW_TINT,
  RULE,
  createSheet,
  draw,
  drawFooters,
  fileNameDate,
  fileNamePart,
  fits,
  formatDate,
  newPage,
  rule,
  toBuffer,
  wrap,
  type PrintMeta,
  type Sheet,
} from '../utils/pdfDraw.js'

/**
 * What comes out of the printer for an employee. Two different papers:
 *
 * renderEmployeeForms - the CHECKLIST form, one page per employee, used to
 * print a selection from the list. A working sheet: what is in, what is
 * outstanding, what is overdue, and a blank or two to fill in by hand.
 *
 * renderEmployeeFile - the employee's FILE, from the button on their own page:
 * their details, then every document they have actually sent in, bound behind
 * it. No checklist anywhere on it.
 *
 * Both are paper, for an office that works on paper: they go round for
 * signatures, they sit in a file, and they are read by people who are not
 * logged in to anything. That shapes every decision here.
 *
 * WHAT IS DELIBERATELY NOT ON IT: the Aadhaar number, the PAN number and any
 * salary. This sheet leaves the desk it was printed at - it is handed about,
 * photocopied and left lying around - and none of those three has anything to
 * do with which documents are outstanding. They are already kept out of list
 * responses and out of the audit trail for that reason; a printout is the last
 * place they should reappear.
 *
 * The checklist form does not attach the documents: it says what has been
 * received and what has not. The file does the opposite - it IS the documents,
 * and says nothing about what is missing.
 *
 * Rendered on the SERVER rather than through the browser's print dialogue, so
 * that every machine in the office produces the same page - same margins, same
 * fonts, same pagination - whatever browser and printer driver it happens to
 * have.
 */

const MARGIN = 42

/** The employee's photograph, when one is on file. PNG or JPEG. */
export interface EmployeePhoto {
  data: Buffer
  mimeType: string
}

export interface EmployeeFormData {
  employee: EmployeeProfile
  documents: readonly EmployeeDocument[]
  photo: EmployeePhoto | null
}

/**
 * What the Print form button on an employee's page produces: their details,
 * and then every document they have actually sent in.
 *
 * NO CHECKLIST. Not the pending documents, not the deadlines, not the counts.
 * This is the file itself - what the office holds - and a page of chasing notes
 * in the middle of it is for the screen to show, not for the copy that gets
 * handed to somebody outside.
 */
export interface EmployeeFileData {
  employee: EmployeeProfile
  photo: EmployeePhoto | null
  /** In the checklist's order, and only the ones with a file behind them. */
  documents: readonly DocumentEntry[]
}

/* -------------------------------------------------------------------------- */
/* The checklist row                                                           */
/* -------------------------------------------------------------------------- */

export type ChecklistStatus = 'Uploaded' | 'Pending' | 'Overdue' | 'Not required'

/**
 * The three words this sheet uses for a document.
 *
 * 'Uploaded' is the definition the counters on every screen already use - a
 * document that has a file and has not been rejected - so a printed form and
 * the list it was printed from can never disagree about how many are in.
 *
 * A REJECTED document reads as outstanding, which is what it is: the file that
 * was sent has been refused, so the paper is still to be collected.
 */
export function checklistStatus(document: EmployeeDocument): ChecklistStatus {
  // Asked first. A document this employee is not asked for is neither received
  // nor outstanding, and a chasing sheet that lists it sends somebody after a
  // form that was deliberately set aside.
  if (document.notRequiredAt !== null) return 'Not required'

  const received =
    document.status === DOCUMENT_STATUS.UPLOADED ||
    document.status === DOCUMENT_STATUS.UNDER_REVIEW ||
    document.status === DOCUMENT_STATUS.VERIFIED

  if (received) return 'Uploaded'
  return document.deadlineState === DEADLINE_STATE.OVERDUE ? 'Overdue' : 'Pending'
}

/* -------------------------------------------------------------------------- */
/* File names                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 'EMP-1010_BHAGWAN_SINGH.pdf'.
 *
 * The code first, because that is what the office files by and what is printed
 * on the service card; the name after it, for the person looking through a
 * downloads folder.
 */
export function formFileName(employee: { employeeCode: string; employeeName: string }): string {
  const parts = [
    fileNamePart(employee.employeeCode.toUpperCase()),
    fileNamePart(employee.employeeName.toUpperCase()),
  ]
  const stem = parts.filter(Boolean).join('_')
  return `${stem || 'EMPLOYEE'}.pdf`
}

/** What a print of several employees is called. */
export function bulkFileName(generatedAt: Date): string {
  return `EMPLOYEE_FORMS_${fileNameDate(generatedAt)}.pdf`
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

function sectionHeading(sheet: Sheet, title: string): void {
  sheet.y -= 14
  draw(sheet.page, title.toUpperCase(), {
    x: sheet.margin,
    y: sheet.y,
    font: sheet.fonts.bold,
    size: 8,
    color: MUTED,
  })
  sheet.y -= 4
}

async function embedPhoto(
  pdf: PDFDocument,
  photo: EmployeePhoto | null,
  employeeId: number,
): Promise<PDFImage | null> {
  if (!photo) return null
  try {
    return photo.mimeType === 'image/png'
      ? await pdf.embedPng(photo.data)
      : await pdf.embedJpg(photo.data)
  } catch (error) {
    logger.warn(
      { err: error, employeeId },
      'employee photograph could not be embedded in the printed form',
    )
    return null
  }
}

/**
 * The letterhead, and the photograph beside it.
 *
 * The photograph is the one thing on this page that can fail for a reason
 * nothing here controls - a file gone from the store, an image a decoder will
 * not take. It is embedded inside a try/catch and simply left out when it will
 * not go in: a form with no picture is still the form somebody asked for, and
 * losing a print of twenty over one thumbnail is not a trade worth making.
 */
async function drawHeader(
  sheet: Sheet,
  employee: EmployeeProfile,
  photo: EmployeePhoto | null,
  subtitle: string,
): Promise<void> {
  const { page, fonts } = sheet
  const top = sheet.y

  const boxWidth = 74
  const boxHeight = 90
  const image = await embedPhoto(sheet.pdf, photo, employee.employeeId)

  if (image) {
    const scale = Math.min(boxWidth / image.width, boxHeight / image.height)
    const width = image.width * scale
    const height = image.height * scale
    page.drawImage(image, {
      x: sheet.margin + sheet.contentWidth - boxWidth + (boxWidth - width) / 2,
      y: top - boxHeight + (boxHeight - height) / 2,
      width,
      height,
    })
  }

  draw(page, 'ASPS International LLP', { x: sheet.margin, y: top - 15, font: fonts.bold, size: 16 })
  draw(page, subtitle, {
    x: sheet.margin,
    y: top - 31,
    font: fonts.regular,
    size: 10,
    color: MUTED,
  })

  sheet.y = top - (image ? boxHeight : 40)
  rule(sheet, 8, 4)
}

interface DetailItem {
  label: string
  value: string
  /** 2 for a value that takes the full width, such as an address. */
  span?: 1 | 2
}

/**
 * The employee's details, as label-above-value pairs.
 *
 * EVERY field is drawn, empty or not, with a dash where there is nothing. A row
 * that disappears when it is empty is a field nobody knows exists, and on a
 * form that goes round the office for completion that is the difference between
 * a blank somebody fills in and a question nobody asks.
 */
function detailsOf(employee: EmployeeProfile): DetailItem[] {
  const orDash = (value: string | null | undefined): string =>
    value === null || value === undefined || value.trim() === '' ? DASH : value

  const items: DetailItem[] = [
    { label: 'Employee ID', value: employee.employeeCode },
    { label: 'Employee name', value: employee.employeeName },
    { label: 'Joining date', value: formatDate(employee.joiningDate) },
    {
      label: 'Employment status',
      value: employee.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? 'Left' : 'Active',
    },
    { label: 'Department', value: orDash(employee.department) },
    { label: 'Designation', value: orDash(employee.designation) },
    { label: 'Date of birth', value: formatDate(employee.dateOfBirth) },
    /* Not a field the record holds. It is printed because the form asks for it,
       and because a dash is a box somebody can fill in by hand; it will carry a
       value the day dbo.Employees gains a FatherName column. */
    { label: "Father's name", value: DASH },
    { label: 'Mobile number', value: orDash(employee.phoneNumber) },
  ]

  // An exit exists from the moment it is recorded, which is usually BEFORE the
  // employee has gone - so these are printed whenever the dates are there, not
  // only once the status has turned to Left.
  if (employee.resignationDate || employee.lastWorkingDate) {
    items.push(
      { label: 'Resignation date', value: formatDate(employee.resignationDate) },
      { label: 'Last working date', value: formatDate(employee.lastWorkingDate) },
      {
        label: 'Reason for leaving',
        value: employee.exitReason ? EXIT_REASON_LABEL[employee.exitReason] : DASH,
      },
    )
  }

  items.push({ label: 'Address', value: orDash(employee.address), span: 2 })

  if (employee.exitNotes) {
    items.push({ label: 'Exit notes', value: employee.exitNotes, span: 2 })
  }

  return items
}

/**
 * The details on the front of the employee file.
 *
 * A different list from the checklist form's, and deliberately so. This page
 * fronts the employee's actual documents, so it says who the papers behind it
 * belong to - date of birth, gender, mobile, address - where the checklist form
 * is a working sheet with a blank for a father's name somebody fills in by hand.
 *
 * STILL NOT ON IT: the Aadhaar number, the PAN number, any salary. This file is
 * the one thing here most likely to leave the building, which makes it the last
 * place those belong - the same rule the checklist form has always followed.
 */
function fileDetailsOf(employee: EmployeeProfile): DetailItem[] {
  const orDash = (value: string | null | undefined): string =>
    value === null || value === undefined || value.trim() === '' ? DASH : value

  const items: DetailItem[] = [
    { label: 'Employee name', value: employee.employeeName },
    { label: 'Employee ID', value: employee.employeeCode },
    { label: 'Department', value: orDash(employee.department) },
    { label: 'Designation', value: orDash(employee.designation) },
    { label: 'Joining date', value: formatDate(employee.joiningDate) },
    {
      label: 'Employment status',
      value: employee.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? 'Left' : 'Active',
    },
    { label: 'Date of birth', value: formatDate(employee.dateOfBirth) },
    { label: 'Gender', value: orDash(employee.gender) },
    { label: 'Mobile number', value: orDash(employee.phoneNumber) },
  ]

  // Only for somebody who has one. On a file that says 'Left', the date they
  // left is the next thing anybody reading it asks.
  if (employee.resignationDate || employee.lastWorkingDate) {
    items.push({ label: 'Last working date', value: formatDate(employee.lastWorkingDate) })
  }

  items.push({ label: 'Address', value: orDash(employee.address), span: 2 })

  return items
}

const DETAIL_GUTTER = 18
const DETAIL_LABEL_DROP = 7
const DETAIL_VALUE_DROP = 19
const DETAIL_LINE_HEIGHT = 12
const DETAIL_ROW_GAP = 8

function drawDetails(sheet: Sheet, items: readonly DetailItem[]): void {
  sectionHeading(sheet, 'Employee details')

  const columnWidth = (sheet.contentWidth - DETAIL_GUTTER) / 2

  let column: 0 | 1 = 0
  let rowTop = sheet.y
  let rowHeight = 0

  const endRow = (): void => {
    sheet.y = rowTop - rowHeight - DETAIL_ROW_GAP
    rowTop = sheet.y
    rowHeight = 0
    column = 0
  }

  for (const item of items) {
    const span = item.span ?? 1
    // A full-width value never shares a row with the pair beside it.
    if (span === 2 && column === 1) endRow()

    const width = span === 2 ? sheet.contentWidth : columnWidth
    const lines = wrap(item.value, sheet.fonts.regular, 9.5, width)
    const height = DETAIL_VALUE_DROP + (lines.length - 1) * DETAIL_LINE_HEIGHT

    if (rowTop - height - DETAIL_ROW_GAP < sheet.margin + sheet.footerSpace) {
      newPage(sheet)
      rowTop = sheet.y
      rowHeight = 0
      column = 0
    }

    const x = sheet.margin + (column === 1 ? columnWidth + DETAIL_GUTTER : 0)
    draw(sheet.page, item.label.toUpperCase(), {
      x,
      y: rowTop - DETAIL_LABEL_DROP,
      font: sheet.fonts.regular,
      size: 7,
      color: MUTED,
    })
    lines.forEach((line, index) => {
      draw(sheet.page, line, {
        x,
        y: rowTop - DETAIL_VALUE_DROP - index * DETAIL_LINE_HEIGHT,
        font: sheet.fonts.regular,
        size: 9.5,
      })
    })

    rowHeight = Math.max(rowHeight, height)
    if (span === 2 || column === 1) endRow()
    else column = 1
  }

  if (column === 1) endRow()
}

/** Column widths, left to right. They add up to the content width. */
const TABLE_COLUMNS = [
  { title: 'Document', width: 214 },
  { title: 'Required', width: 62 },
  { title: 'Status', width: 70 },
  { title: 'Due date', width: 80 },
  { title: 'Uploaded', width: 85.28 },
] as const

const TABLE_HEADER_HEIGHT = 17
const TABLE_ROW_HEIGHT = 17

function columnX(sheet: Sheet, index: number): number {
  let x = sheet.margin
  for (let i = 0; i < index; i += 1) x += TABLE_COLUMNS[i]?.width ?? 0
  return x
}

function drawTableHeader(sheet: Sheet): void {
  sheet.page.drawRectangle({
    x: sheet.margin,
    y: sheet.y - TABLE_HEADER_HEIGHT,
    width: sheet.contentWidth,
    height: TABLE_HEADER_HEIGHT,
    color: HEADER_FILL,
  })

  TABLE_COLUMNS.forEach((column, index) => {
    draw(sheet.page, column.title.toUpperCase(), {
      x: columnX(sheet, index) + 6,
      y: sheet.y - TABLE_HEADER_HEIGHT + 6,
      font: sheet.fonts.bold,
      size: 7.5,
      color: MUTED,
    })
  })

  sheet.y -= TABLE_HEADER_HEIGHT
}

/**
 * The checklist.
 *
 * What is outstanding has to be readable at arm's length by somebody holding
 * the sheet, so 'Pending' and 'Overdue' are set in bold where 'Uploaded' is
 * not, and an overdue row is tinted across its whole width. Both survive a
 * black-and-white photocopier, which a colour would not.
 */
function drawChecklist(sheet: Sheet, form: EmployeeFormData): void {
  const { documents } = form
  const statuses = documents.map(checklistStatus)
  const received = statuses.filter((status) => status === 'Uploaded').length
  const overdue = statuses.filter((status) => status === 'Overdue').length
  // Documents this employee is not asked for come out of the total as well as
  // out of the count received, so the sheet reads '9 of 9' rather than '9 of 10'
  // with one that will never arrive.
  const expected = statuses.filter((status) => status !== 'Not required').length
  const outstanding = expected - received

  sectionHeading(sheet, 'Document checklist')

  sheet.y -= 14
  draw(sheet.page, `${received} of ${expected} documents received`, {
    x: sheet.margin,
    y: sheet.y,
    font: sheet.fonts.bold,
    size: 11.5,
  })

  sheet.y -= 13
  draw(
    sheet.page,
    outstanding === 0
      ? 'Nothing outstanding.'
      : `${outstanding} outstanding${overdue > 0 ? `, of which ${overdue} overdue` : ''}.`,
    { x: sheet.margin, y: sheet.y, font: sheet.fonts.regular, size: 9, color: MUTED },
  )
  sheet.y -= 12

  if (documents.length === 0) {
    draw(sheet.page, 'No checklist has been created for this employee.', {
      x: sheet.margin,
      y: sheet.y,
      font: sheet.fonts.regular,
      size: 9.5,
    })
    sheet.y -= 12
    return
  }

  if (!fits(sheet, TABLE_HEADER_HEIGHT + TABLE_ROW_HEIGHT)) newPage(sheet)
  drawTableHeader(sheet)

  documents.forEach((document, index) => {
    if (!fits(sheet, TABLE_ROW_HEIGHT)) {
      newPage(sheet)
      // The header is drawn again at the top of the continuation: a column of
      // dates with nothing saying which date they are is no use to anybody.
      drawTableHeader(sheet)
    }

    const status = statuses[index] ?? 'Pending'
    const rowBottom = sheet.y - TABLE_ROW_HEIGHT

    if (status === 'Overdue') {
      sheet.page.drawRectangle({
        x: sheet.margin,
        y: rowBottom,
        width: sheet.contentWidth,
        height: TABLE_ROW_HEIGHT,
        color: ROW_TINT,
      })
    }

    const emphasis = status === 'Uploaded' ? sheet.fonts.regular : sheet.fonts.bold
    const cells: { text: string; font: PDFFont }[] = [
      { text: document.documentName, font: sheet.fonts.regular },
      { text: document.isMandatory ? 'Mandatory' : 'Optional', font: sheet.fonts.regular },
      { text: status, font: emphasis },
      { text: formatDate(document.dueDate), font: sheet.fonts.regular },
      { text: formatDate(document.uploadedAt), font: sheet.fonts.regular },
    ]

    cells.forEach((cell, cellIndex) => {
      const column = TABLE_COLUMNS[cellIndex]
      if (!column) return
      const [line] = wrap(cell.text, cell.font, 9, column.width - 12)
      draw(sheet.page, line ?? '', {
        x: columnX(sheet, cellIndex) + 6,
        y: rowBottom + 5.5,
        font: cell.font,
        size: 9,
      })
    })

    sheet.page.drawLine({
      start: { x: sheet.margin, y: rowBottom },
      end: { x: sheet.margin + sheet.contentWidth, y: rowBottom },
      thickness: 0.5,
      color: RULE,
    })

    sheet.y = rowBottom
  })
}

function drawSignatureLine(sheet: Sheet, employee: EmployeeProfile): void {
  if (!fits(sheet, 40)) newPage(sheet)

  sectionHeading(sheet, 'Signature')
  sheet.y -= 13

  const since = employee.signatureUpdatedAt
    ? ` (on file since ${formatDate(employee.signatureUpdatedAt)})`
    : ''

  draw(
    sheet.page,
    employee.hasSignature
      ? `Signature on file: Yes${since}`
      : 'Signature on file: No - not yet collected',
    { x: sheet.margin, y: sheet.y, font: sheet.fonts.regular, size: 9.5 },
  )
  sheet.y -= 12
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Renders one PDF holding a form for each employee given, in the order given.
 *
 * Every employee starts on a fresh page, so a print of twenty is twenty forms
 * that can be separated and filed rather than one continuous roll.
 */
export async function renderEmployeeForms(
  forms: readonly EmployeeFormData[],
  meta: PrintMeta,
): Promise<Buffer> {
  const sheet = await createSheet({ size: A4_PORTRAIT, margin: MARGIN })

  const first = forms[0]
  sheet.pdf.setTitle(
    forms.length === 1 && first
      ? `${first.employee.employeeCode} - ${first.employee.employeeName}`
      : 'ASPS International - employee document forms',
  )
  sheet.pdf.setCreator('ASPS Document Management System')
  sheet.pdf.setProducer('ASPS Document Management System')
  sheet.pdf.setCreationDate(meta.generatedAt)

  for (const [index, form] of forms.entries()) {
    if (index > 0) newPage(sheet)
    await drawHeader(sheet, form.employee, form.photo, 'Employee document form')
    drawDetails(sheet, detailsOf(form.employee))
    drawChecklist(sheet, form)
    drawSignatureLine(sheet, form.employee)
  }

  drawFooters(sheet, meta)

  return toBuffer(sheet)
}

/**
 * One employee's file: their details, then their documents, in one PDF.
 *
 * The details page is ours and carries a footer. Everything after it is the
 * documents as they were filed, running straight on from one another with
 * nothing in between - nothing is stamped across a scanned card, because what
 * this hands over has to still be a copy of what the office holds.
 *
 * An employee with nothing on file gets the details page and stops there. That
 * is a true answer to 'send me their file', and a truer one than an error.
 */
export async function renderEmployeeFile(file: EmployeeFileData, meta: PrintMeta): Promise<Buffer> {
  const sheet = await createSheet({ size: A4_PORTRAIT, margin: MARGIN })

  sheet.pdf.setTitle(`${file.employee.employeeCode} - ${file.employee.employeeName}`)
  sheet.pdf.setCreator('ASPS Document Management System')
  sheet.pdf.setProducer('ASPS Document Management System')
  sheet.pdf.setCreationDate(meta.generatedAt)

  await drawHeader(sheet, file.employee, file.photo, 'Employee file')
  drawDetails(sheet, fileDetailsOf(file.employee))

  // The details can run to a second page - a long address, an exit recorded -
  // and every page they run to is one of ours. Everything appended after this
  // point is somebody's document and is signed by nothing.
  const ownPages = new Set<number>(sheet.pdf.getPages().map((_, index) => index))
  await appendDocuments(sheet, file.documents)

  drawOwnFooters(sheet, ownPages, meta)

  return toBuffer(sheet)
}
