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

  it('never lists somebody who has left', async () => {
    await allEmployeesForDocumentType({ ...FILTERS, documentTypeId: 5 })

    expect(captured.sql).toContain(
      '(e.LastWorkingDate IS NULL OR e.LastWorkingDate >= @today)',
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
