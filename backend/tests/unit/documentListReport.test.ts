import { describe, expect, it, vi } from 'vitest'
import type { PrintDocumentEmployeesQuery } from '@asps-dms/shared'

/**
 * The printed chase list for one document type.
 *
 * Two halves, and they fail differently:
 *
 *   WHAT IS SELECTED - the SQL. Asserted by capturing the statement the
 *   repository builds, because the three rules that matter here are all
 *   predicates: the filters on screen are applied, nobody who has left is in
 *   it, and there is no paging. A list that silently holds the wrong people is
 *   the failure this whole endpoint exists to prevent.
 *
 *   WHAT IS DRAWN - the PDF, read back with pdf.js. Every row printed, on as
 *   many pages as it takes, with the heading and the count somebody reads
 *   before they trust the sheet.
 */

/** The last statement the repository sent, and the values bound to it. */
const captured = vi.hoisted(() => ({ sql: '', inputs: new Map<string, unknown>() }))

vi.mock('../../src/database/pool.js', async () => {
  const mssql = await import('mssql')
  const request = {
    input(name: string, _type: unknown, value: unknown) {
      captured.inputs.set(name, value)
      return request
    },
    query(text: string) {
      captured.sql = text
      return Promise.resolve({ recordset: [] })
    },
  }
  return { createRequest: () => Promise.resolve(request), sql: mssql.default ?? mssql }
})

const { allEmployeesForDocumentType } = await import('../../src/repositories/report.repository.js')
const { formatOfficeDateTime, officeDayStart } = await import('../../src/utils/officeTime.js')
const {
  filterLine,
  listFileName,
  renderDocumentList,
  rowDays,
  rowStatus,
  summaryLine,
} = await import('../../src/services/documentListReport.service.js')

type Row = Awaited<ReturnType<typeof allEmployeesForDocumentType>>[number]

const GENERATED_AT = new Date(2026, 8, 3, 14, 20)
const META = { generatedAt: GENERATED_AT, generatedBy: 'Sameer Hashmi' }

const FILTERS: PrintDocumentEmployeesQuery = {
  outstandingOnly: true,
  onlyOverdue: false,
  sortBy: 'daysOverdue',
  sortDir: 'asc',
}

function row(index: number, overrides: Partial<Row> = {}): Row {
  return {
    employeeId: index,
    employeeCode: `EMP-${1000 + index}`,
    employeeName: `EMPLOYEE ${index}`,
    department: 'CUTTING',
    designation: 'ASSTT. OPERATOR',
    state: 'Overdue',
    dueDate: '2026-08-20',
    daysOverdue: 14,
    receivedAt: null,
    ...overrides,
  }
}

/** 41 outstanding, 34 of them overdue - the list the office actually described. */
function chaseList(): Row[] {
  return Array.from({ length: 41 }, (_, index) =>
    index < 34
      ? row(index + 1)
      : row(index + 1, { state: 'Pending', dueDate: '2026-09-20', daysOverdue: -17 }),
  )
}

/** Reads the words back out of a generated PDF, one string per page. */
async function pagesOf(pdf: Buffer): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const parsed = await getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise

  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return pages
  } finally {
    await parsed.destroy()
  }
}

describe('what the printed list selects', () => {
  it('takes every matching employee, with no paging at all', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 5 })

    // The screen's query pages; this one must not. OFFSET/FETCH here would mean
    // a printed sheet holding 25 of 41 people and saying nothing about it.
    expect(captured.sql).not.toContain('OFFSET')
    expect(captured.sql).not.toContain('FETCH NEXT')
    expect(captured.sql).not.toContain('TOP')
    expect(captured.inputs.get('documentTypeId')).toBe(5)
  })

  it('never lists somebody who has left - but for a type collected after leaving', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 5 })

    // The same scope as the by-document row the page is opened from: a
    // leaver's FNF shows, nobody else who has left does.
    expect(captured.sql.replace(/\s+/g, ' ')).toContain(
      "(e.LastWorkingDate IS NULL OR e.LastWorkingDate >= @today OR d.DocumentTypeId IN" +
        " (SELECT DocumentTypeId FROM dbo.DocumentTypes WHERE DocumentCode IN ('FNF')))",
    )
  })

  it('applies the department filter the screen had', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 5, department: 'CUTTING' })

    expect(captured.sql).toContain('e.Department = @department')
    expect(captured.inputs.get('department')).toBe('CUTTING')
  })

  it('applies overdue-only the same way the screen does', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 5, onlyOverdue: true })

    expect(captured.sql).toContain('d.DueDate IS NOT NULL AND d.DueDate < @today')
  })

  it('keeps the sort the screen was showing', async () => {
    await allEmployeesForDocumentType({
      ...FILTERS,
      documentTypeId: 5,
      sortBy: 'employeeName',
      sortDir: 'desc',
    })

    expect(captured.sql).toContain('ORDER BY e.EmployeeName DESC')
  })
})

describe('the words on the sheet', () => {
  it('summarises the list the way the office says it out loud', () => {
    expect(
      summaryLine({
        documentName: 'PF Form',
        tracksOverdue: true,
        rows: chaseList(),
        filters: FILTERS,
      }),
    ).toBe('PF Form - 41 employees outstanding (34 overdue)')
  })

  it('counts the whole list when those who have sent it are included', () => {
    expect(
      summaryLine({
        documentName: 'PF Form',
        tracksOverdue: true,
        rows: [...chaseList(), row(99, { state: 'Received', daysOverdue: null })],
        filters: { ...FILTERS, outstandingOnly: false },
      }),
    ).toBe('PF Form - 42 employees, 41 outstanding (34 overdue)')
  })

  it('says on the paper what was filtered out of it', () => {
    expect(filterLine({ ...FILTERS, department: 'CUTTING', onlyOverdue: true })).toBe(
      'Department: CUTTING  ·  Overdue only  ·  Current employees only',
    )
    expect(filterLine(FILTERS)).toBe(
      'All departments  ·  Outstanding only  ·  Current employees only',
    )
  })

  it('never reads a document nobody must send as late', () => {
    const late = row(1, { state: 'Overdue', daysOverdue: 14 })
    expect(rowStatus(late, true)).toBe('Overdue')
    expect(rowStatus(late, false)).toBe('Pending')
    expect(rowDays(late, false)).toBe('—')
  })

  it('says how long, in whichever direction', () => {
    expect(rowDays(row(1, { daysOverdue: 14 }), true)).toBe('14 overdue')
    expect(rowDays(row(1, { state: 'Pending', daysOverdue: 0 }), true)).toBe('due today')
    expect(rowDays(row(1, { state: 'Pending', daysOverdue: -3 }), true)).toBe('3 to go')
    expect(rowDays(row(1, { state: 'Received', daysOverdue: null }), true)).toBe('—')
  })

  it('names the file after the document, what was asked of it, and the day', () => {
    expect(listFileName('PF Form', FILTERS, GENERATED_AT)).toBe('PF_Form_pending_2026-09-03.pdf')
    expect(listFileName('PF Form', { ...FILTERS, onlyOverdue: true }, GENERATED_AT)).toBe(
      'PF_Form_overdue_2026-09-03.pdf',
    )
    expect(
      listFileName('Form No. 16', { ...FILTERS, outstandingOnly: false }, GENERATED_AT),
    ).toBe('Form_No_16_all_2026-09-03.pdf')
  })
})

describe('renderDocumentList', () => {
  it('prints all 41 employees, not the 25 that were on screen', async () => {
    const rows = chaseList()
    const pdf = await renderDocumentList(
      { documentName: 'PF Form', tracksOverdue: true, rows, filters: FILTERS },
      META,
    )

    const pages = await pagesOf(pdf)
    const all = pages.join(' ')

    for (const one of rows) expect(all).toContain(one.employeeCode)
    expect(pages[0]).toContain('PF Form')
    expect(pages[0]).toContain('PF Form - 41 employees outstanding (34 overdue)')
    expect(pages[0]).toContain('Generated 03/09/2026 14:20 by Sameer Hashmi')
  })

  it('is landscape, so the table has room across', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const pdf = await PDFDocument.load(
      await renderDocumentList(
        { documentName: 'PF Form', tracksOverdue: true, rows: chaseList(), filters: FILTERS },
        META,
      ),
    )

    const [first] = pdf.getPages()
    expect(first?.getWidth()).toBeGreaterThan(first?.getHeight() ?? 0)
  })

  it('carries a list of 300 across pages, each one headed and numbered', async () => {
    const rows = Array.from({ length: 320 }, (_, index) => row(index + 1))
    const pdf = await renderDocumentList(
      { documentName: 'Bio Data Form', tracksOverdue: true, rows, filters: FILTERS },
      META,
    )

    const pages = await pagesOf(pdf)
    expect(pages.length).toBeGreaterThan(1)

    // Nobody is dropped at a page boundary, which is where a list like this
    // loses people.
    const all = pages.join(' ')
    for (const one of rows) expect(all).toContain(one.employeeCode)

    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`)
      // Every page says what it is a list of, and repeats the column headings.
      expect(page).toContain('Bio Data Form')
      expect(page).toContain('EMPLOYEE ID')
    })
    for (const page of pages.slice(1)) expect(page).toContain('(continued)')
  })

  it('prints the filtered list only, and says so on the paper', async () => {
    const rows = chaseList()
      .slice(0, 6)
      .map((one) => ({ ...one, department: 'CUTTING' }))

    const [page = ''] = await pagesOf(
      await renderDocumentList(
        {
          documentName: 'ESIC Form',
          tracksOverdue: true,
          rows,
          filters: { ...FILTERS, department: 'CUTTING', onlyOverdue: true },
        },
        META,
      ),
    )

    expect(page).toContain('ESIC Form - 6 employees outstanding (6 overdue)')
    expect(page).toContain('Department: CUTTING')
    expect(page).toContain('Overdue only')
  })

  it('says so plainly when the filters match nobody', async () => {
    const [page = ''] = await pagesOf(
      await renderDocumentList(
        { documentName: 'Aadhaar Card', tracksOverdue: true, rows: [], filters: FILTERS },
        META,
      ),
    )

    expect(page).toContain('Nobody matches these filters')
  })

  it('carries no identity number and nothing about pay', async () => {
    // The rows this renderer is given cannot hold them - it is handed the
    // report row, not the employee record - and this is the assertion that
    // keeps it that way.
    const [page = ''] = await pagesOf(
      await renderDocumentList(
        { documentName: 'PF Form', tracksOverdue: true, rows: chaseList(), filters: FILTERS },
        META,
      ),
    )

    expect(page.toLowerCase()).not.toContain('aadhaar number')
    expect(page.toLowerCase()).not.toContain('pan')
    expect(page.toLowerCase()).not.toContain('salary')
    expect(page).not.toMatch(/\b\d{12}\b/)
  })
})

/**
 * The upload-date range (FNF's page): which documents ARRIVED in these office
 * days. A row with no file has no upload date, so a range lists sent-in rows
 * and sets the 'still to come' filters aside - on the server, so the screen,
 * the PDF and the spreadsheet agree.
 */
describe('a date range on when the document was uploaded', () => {
  it('lists the documents that arrived in it, whatever outstandingOnly and onlyOverdue say', async () => {
    captured.inputs.clear()
    await allEmployeesForDocumentType({
      ...FILTERS,
      documentTypeId: 11,
      outstandingOnly: true,
      onlyOverdue: true,
      uploadedFrom: '2026-10-29',
      uploadedTo: '2026-10-30',
    })

    // The WHERE clause alone: the column list has its own CASE on the file.
    const sql = captured.sql.replace(/\s+/g, ' ')
    const where = sql.slice(sql.indexOf(' WHERE '), sql.indexOf(' ORDER BY '))
    expect(where).toContain('d.OriginalFilePath IS NOT NULL')
    expect(where).toContain('d.UploadedAt >= @uploadedFrom')
    expect(where).toContain('d.UploadedAt < @uploadedBefore')
    // Neither 'still to come' filter survives a range.
    expect(where).not.toContain('d.OriginalFilePath IS NULL')
    expect(where).not.toContain('d.DueDate < @today')
    // Office days, bound as the instants they start and the day after starts:
    // the whole of 30 October is in, 31 October is not.
    expect(captured.inputs.get('uploadedFrom')).toEqual(officeDayStart('2026-10-29'))
    expect(captured.inputs.get('uploadedBefore')).toEqual(officeDayStart('2026-10-31'))
  })

  it('takes either end alone', async () => {
    captured.inputs.clear()
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 11, uploadedFrom: '2026-10-29' })
    expect(captured.sql).toContain('d.UploadedAt >= @uploadedFrom')
    expect(captured.sql).not.toContain('@uploadedBefore')

    captured.inputs.clear()
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 11, uploadedTo: '2026-10-30' })
    expect(captured.sql).toContain('d.UploadedAt < @uploadedBefore')
    expect(captured.sql).not.toContain('@uploadedFrom')
  })

  it('leaves the list as it was when no range is set', async () => {
    captured.inputs.clear()
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 11 })
    expect(captured.sql).toContain('d.OriginalFilePath IS NULL')
    expect(captured.sql).not.toContain('UploadedAt >=')
  })

  it('selects and sorts by when the file was received', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 11, sortBy: 'uploadedAt', sortDir: 'desc' })
    const sql = captured.sql.replace(/\s+/g, ' ')
    expect(sql).toContain('CASE WHEN d.OriginalFilePath IS NULL THEN NULL ELSE d.UploadedAt END AS UploadedAt')
    expect(sql).toContain('ORDER BY d.UploadedAt DESC, e.EmployeeId ASC')
  })

  it('says the range on the paper, and that the sheet holds leavers when it does', () => {
    expect(filterLine({ ...FILTERS, uploadedFrom: '2026-10-29', uploadedTo: '2026-10-30' })).toBe(
      'All departments  ·  Received 29/10/2026 to 30/10/2026  ·  Current employees only',
    )
    expect(
      filterLine(
        { ...FILTERS, uploadedFrom: '2026-10-29', uploadedTo: '2026-10-29' },
        { includesLeavers: true },
      ),
    ).toBe('All departments  ·  Received on 29/10/2026  ·  Including employees who have left')
    expect(filterLine({ ...FILTERS, uploadedFrom: '2026-10-29' })).toContain('Received from 29/10/2026')
    expect(filterLine({ ...FILTERS, uploadedTo: '2026-10-30' })).toContain('Received up to 30/10/2026')
    // FNF's sheet never says 'Current employees only' over people who have left.
    expect(filterLine(FILTERS, { includesLeavers: true })).not.toContain('Current employees only')
  })

  it('counts and names a range sheet as what arrived, not what is outstanding', () => {
    const received = row(1, { state: 'Received', daysOverdue: null, receivedAt: '2026-10-29T05:00:00.000Z' })
    const filters = { ...FILTERS, uploadedFrom: '2026-10-29' }
    expect(
      summaryLine({ documentName: 'FNF', tracksOverdue: false, rows: [received], filters }),
    ).toBe('FNF - 1 employee, 0 outstanding')
    expect(listFileName('FNF', filters, GENERATED_AT)).toBe('FNF_received_2026-09-03.pdf')
  })

  it('prints a Received on column, in the office clock', async () => {
    const received = row(1, { state: 'Received', daysOverdue: null, receivedAt: '2026-10-29T05:00:00.000Z' })
    const pdf = await renderDocumentList(
      { documentName: 'FNF', tracksOverdue: false, rows: [received, row(2)], filters: FILTERS },
      META,
    )
    const [first] = await pagesOf(pdf)
    // Column titles are printed in capitals; the time must print whole, not cut.
    expect(first).toContain('RECEIVED ON')
    expect(first).toContain(formatOfficeDateTime('2026-10-29T05:00:00.000Z'))
  })
})

describe('the office clock', () => {
  it('starts an office day at midnight on the server clock', () => {
    const start = officeDayStart('2026-10-30')
    expect([start.getFullYear(), start.getMonth() + 1, start.getDate()]).toEqual([2026, 10, 30])
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0])
  })

  it('reads a stored instant as the office does', () => {
    const at = new Date(2026, 9, 29, 9, 41)
    expect(formatOfficeDateTime(at.toISOString())).toBe('29/10/2026 09:41')
  })
})
