import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPLOYEE_STATUS_FILTERS, type EmployeeListQuery } from '@asps-dms/shared'

/**
 * Who this system counts, and whether every reader agrees.
 *
 * Two things are held together here.
 *
 * THE SCOPE - nobody who has left, nothing on an archived record - which every
 * count, list, report and email has to apply, and which has one definition in
 * employeeScope.ts. The last block below runs each reader and insists on it.
 *
 * And THE TILES against the lists they open, counted the same way.
 *
 * Every tile is now a link, which turns a cosmetic difference into a visible
 * bug: a tile that says 5 opening a list of 4 reads as the list having lost
 * somebody. The two numbers come from different queries in different files, so
 * the only way to hold them together is to compare the SQL - which is what this
 * does. It captures the statement each side builds and asserts that the
 * predicates are the same text.
 *
 * Whitespace is squashed before comparing: the dashboard writes its predicates
 * across several lines and the lists write them on one, and that is not a
 * difference anybody cares about.
 */

const captured = vi.hoisted(() => ({ statements: [] as string[], inputs: new Map<string, unknown>() }))

vi.mock('../../src/database/pool.js', async () => {
  const mssql = await import('mssql')
  const request = {
    input(name: string, _type: unknown, value: unknown) {
      captured.inputs.set(name, value)
      return request
    },
    query(text: string) {
      captured.statements.push(text)
      return Promise.resolve({ recordset: [] })
    },
  }
  return {
    createRequest: () => Promise.resolve(request),
    getPool: () => Promise.resolve({ request: () => request }),
    sql: mssql.default ?? mssql,
  }
})

const dashboard = await import('../../src/repositories/dashboard.repository.js')
const employees = await import('../../src/repositories/employee.repository.js')
const documents = await import('../../src/repositories/employeeDocument.repository.js')
const reports = await import('../../src/repositories/report.repository.js')
const reminders = await import('../../src/repositories/reminder.repository.js')
const { COUNTABLE_DOCUMENT, COUNTABLE_EMPLOYEE, EFFECTIVE_LEFT } = await import(
  '../../src/repositories/employeeScope.js'
)

const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/** The last statement built, with its whitespace flattened. */
function lastSql(): string {
  const statement = captured.statements[captured.statements.length - 1]
  if (statement === undefined) throw new Error('no statement was built')
  return squash(statement)
}

/**
 * The dashboard's one query.
 *
 * It is allowed to fail on the way out - the fake returns no rows and the
 * repository quite rightly objects to that. What is under test is the statement
 * it built on the way in.
 */
async function dashboardSql(): Promise<string> {
  await dashboard.getSummary(7).catch(() => undefined)
  return lastSql()
}

const listQuery = (overrides: Partial<EmployeeListQuery> = {}): EmployeeListQuery => ({
  page: 1,
  pageSize: 25,
  sortBy: 'employeeName',
  sortDir: 'asc',
  status: EMPLOYEE_STATUS_FILTERS.ACTIVE,
  includeArchived: false,
  archivedOnly: false,
  missingIdCard: false,
  withoutSignature: false,
  leftThisYear: false,
  ...overrides,
})

async function employeeListSql(overrides: Partial<EmployeeListQuery> = {}): Promise<string> {
  await employees.list(listQuery(overrides)).catch(() => undefined)
  return lastSql()
}

/**
 * Just the WHERE clause of a list query.
 *
 * The SELECT names every column on the table, so asserting that a query does
 * NOT mention e.LastWorkingDate has to look at what it FILTERS on rather than
 * at what it reads.
 */
function whereOf(sql: string): string {
  const from = sql.indexOf(' WHERE ')
  if (from === -1) return ''
  const to = sql.indexOf(' ORDER BY ', from)
  return to === -1 ? sql.slice(from) : sql.slice(from, to)
}

async function documentListSql(
  state: 'all' | 'received' | 'pending' | 'overdue' | 'dueSoon',
): Promise<string> {
  await documents
    .listAll({ page: 1, pageSize: 25, sortBy: 'dueDate', sortDir: 'asc', state })
    .catch(() => undefined)
  return lastSql()
}

beforeEach(() => {
  captured.statements = []
  captured.inputs.clear()
})

describe('the document tiles and the documents list', () => {
  /**
   * Each tile's predicate, exactly as dashboard.repository.ts writes it.
   *
   * These strings are the contract. If somebody changes how a tile counts and
   * not how its list selects, this is what notices.
   */
  const PREDICATES = {
    received: 'd.OriginalFilePath IS NOT NULL',
    pending: 'd.OriginalFilePath IS NULL',
    overdue: 'd.OriginalFilePath IS NULL AND d.DueDate IS NOT NULL AND d.DueDate < @today',
    dueSoon:
      'd.OriginalFilePath IS NULL AND d.DueDate IS NOT NULL AND d.DueDate >= @today' +
      ' AND d.DueDate <= DATEADD(DAY, @dueSoonDays, @today)',
  } as const

  it('counts each state with the predicate the dashboard counts it with', async () => {
    const summary = await dashboardSql()

    for (const [state, predicate] of Object.entries(PREDICATES)) {
      expect(summary, `dashboard tile: ${state}`).toContain(predicate)
      expect(await documentListSql(state as keyof typeof PREDICATES), `list: ${state}`).toContain(
        predicate,
      )
    }
  })

  it('leaves out the people the dashboard leaves out', async () => {
    // Somebody who has left cannot bring a document in, so their outstanding
    // paperwork is not counted on the dashboard - and must not appear in the
    // list either, or the list would be longer than the tile.
    const list = await documentListSql('pending')

    expect(list).toContain('e.IsActive = 1')
    expect(list).toContain('(e.LastWorkingDate IS NULL OR e.LastWorkingDate >= @today)')
    expect(list).toContain('d.IsActive = 1')
  })

  it('counts rows rather than people, which is why the tiles open this list', async () => {
    // One row per employee per document type: 'Still to come 57' is 57 of
    // these, not 57 employees.
    const list = await documentListSql('all')

    expect(list).toContain('FROM dbo.EmployeeDocuments AS d')
    expect(list).toContain('INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId')
    // And it names the document, so a printed or read line says which one.
    expect(list).toContain('dt.DocumentName')
  })
})

describe('the employee tiles and the employee list', () => {
  /**
   * Total = Active + Left, proved on the predicates rather than on a fixture.
   *
   * The three subqueries partition the same set: Total is IsActive = 1, and the
   * other two are that same condition split by whether the last working day has
   * passed. Nothing can be in both and nothing can be in neither, so the
   * arithmetic on the screen holds whatever is in the table.
   */
  it('counts Total as exactly Active plus Left, with the archived left out', async () => {
    const summary = await dashboardSql()

    expect(summary).toContain('FROM dbo.Employees WHERE IsActive = 1) AS ActiveAndLeft')

    // The two halves: both inside IsActive = 1, split on the same condition.
    expect(summary).toContain(`${COUNTABLE_EMPLOYEE}) AS Total`)
    expect(summary).toContain(
      'WHERE IsActive = 1 AND LastWorkingDate IS NOT NULL AND LastWorkingDate < @today) AS [Left]',
    )

    // Archived records are in none of the three - they are struck-out entries,
    // not people who worked here.
    expect(summary).toContain('FROM dbo.Employees WHERE IsActive = 0) AS Archived')
  })

  it('opens Total on the same employees it counted', async () => {
    const where = whereOf(await employeeListSql({ status: EMPLOYEE_STATUS_FILTERS.ALL }))

    // 'all' adds no condition of its own, so the filter is IsActive = 1 - the
    // tile's own predicate, and nothing else. Anything more would make the list
    // shorter than the number that opened it.
    expect(where).toContain('e.IsActive = 1')
    expect(where).not.toContain('e.LastWorkingDate')
    expect(where).not.toContain('e.ResignationDate')
  })

  it('opens Active on the same employees the tile counted', async () => {
    const summary = await dashboardSql()
    const list = await employeeListSql()

    // The dashboard says 'has not left yet' one way round and the list says it
    // the other; they are the same condition by De Morgan, and both are here so
    // that changing one without the other is visible.
    expect(summary).toContain(COUNTABLE_EMPLOYEE)
    expect(list).toContain('e.IsActive = 1')
    expect(list).toContain('NOT (e.LastWorkingDate IS NOT NULL AND e.LastWorkingDate < @today)')
  })

  it('opens Left this year on the year the dashboard counted', async () => {
    const summary = await dashboardSql()
    const list = await employeeListSql({
      status: EMPLOYEE_STATUS_FILTERS.LEFT,
      leftThisYear: true,
    })

    expect(summary).toContain('YEAR(LastWorkingDate) = YEAR(@today)')
    expect(list).toContain(
      'e.LastWorkingDate IS NOT NULL AND e.LastWorkingDate < @today AND YEAR(e.LastWorkingDate) = YEAR(@today)',
    )
    // Archived records are out of the count, so they are out of the list too.
    expect(list).toContain('e.IsActive = 1')
  })

  it('opens Archived on the archived records only', async () => {
    const summary = await dashboardSql()
    const list = await employeeListSql({
      archivedOnly: true,
      status: EMPLOYEE_STATUS_FILTERS.ALL,
    })

    expect(summary).toContain('FROM dbo.Employees WHERE IsActive = 0')
    expect(list).toContain('e.IsActive = 0')
    expect(list).not.toContain('e.IsActive = 1')
  })

  it('opens Missing an ID card on the employees the tile counted', async () => {
    const summary = await dashboardSql()
    const list = await employeeListSql({ missingIdCard: true })

    // The two cards BY CODE, on both sides. It was the mandatory flag, which
    // picked them out only while they were the only mandatory documents -
    // eight of the ten are mandatory now.
    expect(summary).toContain("dt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')")
    expect(squash(list)).toContain("idt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')")
    expect(squash(list)).toContain('idc.OriginalFilePath IS NULL')
    expect(list).toContain('EXISTS')
  })

  it('opens Pending employee signature on the employees who have never signed', async () => {
    const summary = await dashboardSql()
    const list = await employeeListSql({ withoutSignature: true })

    expect(summary).toContain('NOT EXISTS (SELECT 1 FROM dbo.EmployeeSignatures')
    expect(squash(list)).toContain('NOT EXISTS ( SELECT 1 FROM dbo.EmployeeSignatures AS sig')
    // An enrolled signature that was later replaced leaves an inactive row
    // behind; both sides count only the live one.
    expect(squash(list)).toContain('sig.IsActive = 1')
  })

  it('splits by gender the way the dashboard splits it', async () => {
    const summary = await dashboardSql()

    expect(summary).toContain("Gender = 'Male'")
    expect(summary).toContain('Gender IS NULL')

    // A recorded gender is bound, never written into the statement.
    const male = await employeeListSql({ gender: 'Male' })
    expect(male).toContain('e.Gender = @gender')
    expect(captured.inputs.get('gender')).toBe('Male')

    // 'Not recorded' is the absence of one, so there is nothing to bind.
    const missing = await employeeListSql({ gender: 'notRecorded' })
    expect(missing).toContain('e.Gender IS NULL')
  })
})

describe('one definition of who is countable', () => {
  /**
   * Every count, list, report and email, asked the same question.
   *
   * The rule - nobody who has left, nothing on an archived record - held only
   * because a dozen queries each remembered to write it out. This is what makes
   * the next screen inherit it: whatever a reader is for, its SQL has to carry
   * the shared fragment. A new query that forgets fails here rather than in the
   * office, six weeks later, when somebody asks why a man who left in March is
   * on the chase list.
   */
  const readers: [string, () => Promise<unknown>, string][] = [
    ['the dashboard', () => dashboard.getSummary(7), COUNTABLE_EMPLOYEE],
    [
      'the documents list',
      () =>
        documents.listAll({ page: 1, pageSize: 25, sortBy: 'dueDate', sortDir: 'asc', state: 'all' }),
      COUNTABLE_DOCUMENT,
    ],
    ['the by-document report', () => reports.byDocumentType(), COUNTABLE_DOCUMENT],
    [
      'the outstanding report',
      () => reports.outstanding({ onlyOverdue: false, onlyMandatory: false }),
      COUNTABLE_DOCUMENT,
    ],
    [
      'the employees behind one document',
      () =>
        reports.employeesForDocumentType({
          documentTypeId: 1,
          outstandingOnly: true,
          onlyOverdue: false,
          sortBy: 'daysOverdue',
          sortDir: 'asc',
          page: 1,
          pageSize: 25,
        }),
      COUNTABLE_DOCUMENT,
    ],
    [
      'the printed chase list',
      () =>
        reports.allEmployeesForDocumentType({
          documentTypeId: 1,
          outstandingOnly: true,
          onlyOverdue: false,
          sortBy: 'daysOverdue',
          sortDir: 'asc',
        }),
      COUNTABLE_DOCUMENT,
    ],
    ["the daily digest's spreadsheet", () => reminders.findPendingDocuments(), COUNTABLE_DOCUMENT],
  ]

  for (const [name, run, fragment] of readers) {
    it(`${name} counts only employees who are here`, async () => {
      await run().catch(() => undefined)

      expect(lastSql(), name).toContain(squash(fragment))
      // The fragment reads @today, so whoever uses it must bind it. The digest
      // did not, and asked the driver for a variable it had never declared.
      expect(captured.inputs.has('today'), `${name} binds @today`).toBe(true)
    })
  }

  it('leaves the employee list the filters somebody chose for themselves', async () => {
    // The list is the one screen where somebody may deliberately ask for
    // leavers or archived records - that is what the filters are for - so it
    // composes the same two halves rather than taking the fragment whole.
    const list = await employeeListSql()

    expect(list).toContain('e.IsActive = 1')
    expect(list).toContain('NOT (e.LastWorkingDate IS NOT NULL AND e.LastWorkingDate < @today)')
  })
})
/**
 * The Employment filter, and the archived records.
 *
 * Reported from the office on 2026-09-07: 549 employees, all active, none
 * archived, and the third option on the Employment dropdown listed all 549.
 * Archive one and it listed 548. The list was answering 'everybody except the
 * archived' to a question that read as 'only the archived'.
 *
 * The predicates below were correct; there was no Archived option to choose,
 * only an 'All' that nobody reads as excluding anything. These assertions pin
 * down what each of the four choices now sends, so the dropdown and the SQL
 * cannot drift apart again.
 */
describe('which employees the list asks for', () => {
  const where = async (overrides: Partial<EmployeeListQuery>): Promise<string> =>
    whereOf(await employeeListSql(overrides))

  it('lists the people still here by default, and leaves the archived out', async () => {
    const sql = await where({})

    expect(sql).toContain('e.IsActive = 1')
    expect(sql).toContain(`NOT ${EFFECTIVE_LEFT}`)
  })

  it('lists those who have an exit recorded under Left', async () => {
    const sql = await where({ status: EMPLOYEE_STATUS_FILTERS.LEFT })

    expect(sql).toContain('e.ResignationDate IS NOT NULL')
    // Still only the records the office has not finished with.
    expect(sql).toContain('e.IsActive = 1')
  })

  it('asks nothing about the exit under All, and still leaves the archived out', async () => {
    // What the office was reading as 'Archived'. It is not: it is everybody,
    // here or gone, whose record is live - which is why it showed all 549.
    const sql = await where({ status: EMPLOYEE_STATUS_FILTERS.ALL })

    expect(sql).toContain('e.IsActive = 1')
    expect(sql).not.toContain('e.ResignationDate IS NOT NULL')
    expect(sql).not.toContain(`NOT ${EFFECTIVE_LEFT}`)
  })

  it('lists ONLY the archived when that is what was asked for', async () => {
    // The bug as it was reported: this must be the archived one, not the
    // other 548.
    const sql = await where({ status: EMPLOYEE_STATUS_FILTERS.ALL, archivedOnly: true })

    expect(sql).toContain('e.IsActive = 0')
    expect(sql).not.toContain('e.IsActive = 1')
  })

  it('lists the archived alongside the rest when the checkbox is ticked', async () => {
    const sql = await where({ includeArchived: true })

    // Neither: nothing is said about IsActive at all, so both sides come back.
    expect(sql).not.toContain('e.IsActive = 1')
    expect(sql).not.toContain('e.IsActive = 0')
  })

  it('reads Archived as the narrower answer when the checkbox is ticked too', async () => {
    // The two controls are the same axis - hidden, alongside, or on their own -
    // so the narrowest wins rather than the two cancelling out.
    const sql = await where({ archivedOnly: true, includeArchived: true })

    expect(sql).toContain('e.IsActive = 0')
  })

  it('keeps the archived out of a search, which is where a stale record hurts', async () => {
    const sql = await where({ search: 'BHAGWAN' })

    expect(sql).toContain('e.IsActive = 1')
  })
})

/**
 * A document that is not required of THIS employee.
 *
 * ESIC does not apply to everybody. The decision lives on the employee's row,
 * and the risk it carries is the one this whole file exists to catch: seven
 * separate queries count documents, and a rule applied to six of them produces
 * a dashboard that disagrees with the list it opens.
 *
 * Every one of the seven is asserted here, by name.
 */
describe('documents nobody is asked for', () => {
  const NOT_REQUIRED = 'd.NotRequiredAt IS NULL'

  it('is part of the one definition the counts share', async () => {
    expect(COUNTABLE_DOCUMENT).toContain(NOT_REQUIRED)
  })

  it('is left out of every dashboard count', async () => {
    const summary = await dashboardSql()

    // Total, received, pending, overdue, due soon - all of them go through
    // COUNTABLE_DOCUMENT, so the count of that predicate is the count of them.
    expect(summary.split(NOT_REQUIRED).length - 1).toBeGreaterThanOrEqual(5)
  })

  it('cannot make an employee incomplete on the dashboard', async () => {
    // The requirement in one line: nine documents in and ESIC set aside reads
    // as Complete. These two subqueries write their own scope, so they are the
    // ones that have to remember.
    const summary = await dashboardSql()

    expect(summary).toContain(
      squash(`AND NOT EXISTS (SELECT 1 FROM dbo.EmployeeDocuments AS d
        WHERE d.EmployeeId = e.EmployeeId AND d.IsActive = 1 AND ${NOT_REQUIRED}`),
    )
    expect(summary).toContain(
      squash(`AND EXISTS (SELECT 1 FROM dbo.EmployeeDocuments AS d
        WHERE d.EmployeeId = e.EmployeeId AND d.IsActive = 1 AND ${NOT_REQUIRED}`),
    )
  })

  it('is left out of the counters behind the employee list and profile', async () => {
    // 'N of N pending', the four numbers on the profile, and the sort by
    // documents outstanding all read these. Total falls with the rest, so an
    // employee who owes nine reads 9 rather than 10.
    const list = await employeeListSql()

    expect(list).toContain(squash(`FROM dbo.EmployeeDocuments AS d
      WHERE d.EmployeeId = e.EmployeeId AND d.IsActive = 1 AND ${NOT_REQUIRED}`))
  })

  it('cannot keep an employee out of the Complete filter', async () => {
    const complete = await employeeListSql({ checklist: 'complete' })

    expect(complete).toContain('cd.NotRequiredAt IS NULL')
  })

  it('is left out of the documents list the tiles open', async () => {
    for (const state of ['all', 'pending', 'overdue'] as const) {
      expect(await documentListSql(state), state).toContain(NOT_REQUIRED)
    }
  })

  it('is left out of both reports and of the daily reminder email', async () => {
    // Each of these reads COUNTABLE_DOCUMENT, which now carries the rule - so
    // nobody is chased by email for a form nobody is waiting for.
    const readers: [string, () => Promise<unknown>][] = [
      ['the by-document report', () => reports.byDocumentType()],
      [
        'the chase list',
        () => reports.outstanding({ onlyOverdue: false, onlyMandatory: false }),
      ],
      ['the daily reminder email', () => reminders.findPendingDocuments()],
    ]

    for (const [name, run] of readers) {
      await run().catch(() => undefined)
      expect(lastSql(), name).toContain(NOT_REQUIRED)
    }
  })
})
