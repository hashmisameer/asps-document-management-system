import { describe, expect, it } from 'vitest'
import {
  IMPORT_COLUMNS,
  looksTruncated,
  normaliseEmployeeCode,
  parseCsv,
  parseImportDate,
  planImport,
  planRow,
  readRows,
  readRowsByPosition,
} from '../../src/services/employeeImport.service.js'

/**
 * Reading the employee master out of the office's spreadsheet.
 *
 * The rows below are the real ones, copied from the export of 568 people: the
 * addresses with commas in them, the two mobile numbers with eleven digits,
 * the fifty blank lines Excel leaves at the end, and the one employee who is
 * already on the system.
 *
 * What is being protected is the thing that makes a bulk import safe: a file
 * with something wrong in it must import everybody it can, say exactly what it
 * could not, and do nothing at all on a dry run.
 */

const HEADER = IMPORT_COLUMNS.join(',')

const FILE = [
  HEADER,
  '00000068,MD RAJJAK ALAM,4/11/2022,TROUSER ASSEMBLY 2,MANAGER,9582435365,SEC 68 GARHI CHAUKHANDI NOIDA,ACTIVE,TRUE',
  '00000092,PUSHPENDER KUMAR,3/1/2024,ADMIN,DRIVER,8800926500,"A-106A BASTI, R K PURAM NEW DELHI, 110022",ACTIVE,TRUE',
  '00005609,ASHA  DEVI,4/2/2026,JACKET FRONT,ASSTT.OPERATER,80577679433,BEHLOLPUR C /O PAPPU NOIDA U .P.,ACTIVE,TRUE',
  '00006016,BHAGWAN SINGH,8/1/2026,JACKET ASSEMBLY-1,ASSTT.PRESSMAN,8954799754,GARI CHAUKHANDI SEC -68 NOIDA UP,ACTIVE,TRUE',
  '00010051,GAURAV KUMAR,5/8/2026,ADMIN,MERCHANDISER,,,ACTIVE,TRUE',
  ',,,,,,,,',
  ',,,,,,,,',
].join('\r\n')

const rowsOf = (text: string) => readRows(text).rows

describe('reading the file', () => {
  it('keeps an address that has commas inside it', () => {
    const rows = rowsOf(FILE)

    expect(rows[1]?.values.address).toBe('A-106A BASTI, R K PURAM NEW DELHI, 110022')
  })

  it('drops the blank lines Excel leaves behind', () => {
    // The office's export ends with fifty of them.
    expect(rowsOf(FILE)).toHaveLength(5)
  })

  it('counts lines the way the spreadsheet does, so an error can be found', () => {
    const rows = rowsOf(FILE)

    expect(rows[0]?.line).toBe(2)
    expect(rows[4]?.line).toBe(6)
  })

  it('reads a quote inside a quoted field', () => {
    expect(parseCsv('a,"say ""hi""",b')[0]).toEqual(['a', 'say "hi"', 'b'])
  })

  it('survives the byte-order mark Excel writes', () => {
    const rows = rowsOf(`${String.fromCharCode(0xfeff)}${FILE}`)

    expect(rows).toHaveLength(5)
    expect(rows[0]?.values.employee_code).toBe('00000068')
  })

  it('says which columns are missing rather than guessing', () => {
    const { missingColumns } = readRows('employee_code,full_name\n00000068,SOMEBODY')

    expect(missingColumns).toContain('joining_date')
    expect(missingColumns).toContain('designation')
  })
})

describe('reading a date', () => {
  it('reads the office export as month/day/year', () => {
    // '6/23/2023' can only be June, which is how the format was settled.
    expect(parseImportDate('4/11/2022', 'mdy')).toBe('2022-04-11')
    expect(parseImportDate('6/23/2023', 'mdy')).toBe('2023-06-23')
  })

  it('reads the same text the other way round when told to', () => {
    // Getting this wrong moves every deadline in the company, so it is a
    // choice somebody makes rather than a guess.
    expect(parseImportDate('4/11/2022', 'dmy')).toBe('2022-11-04')
  })

  it('takes an ISO date as it stands', () => {
    expect(parseImportDate('2022-04-11', 'mdy')).toBe('2022-04-11')
  })

  it('refuses a day that does not exist', () => {
    // Four digits in the right places, and not a day.
    expect(parseImportDate('2/31/2026', 'mdy')).toBeNull()
    expect(parseImportDate('13/1/2026', 'mdy')).toBeNull()
    expect(parseImportDate('not a date', 'mdy')).toBeNull()
    expect(parseImportDate('', 'mdy')).toBeNull()
  })

  it('knows a leap day from a made-up one', () => {
    expect(parseImportDate('2/29/2028', 'mdy')).toBe('2028-02-29')
    expect(parseImportDate('2/29/2027', 'mdy')).toBeNull()
  })
})

describe('judging one row', () => {
  const rowFor = (line: string) => {
    const rows = rowsOf([HEADER, line].join('\n'))
    const row = rows[0]
    if (!row) throw new Error('no row')
    return planRow(row, 'mdy')
  }

  it('reads a complete row into what the form would have produced', () => {
    const plan = rowFor(
      '00000068,MD RAJJAK ALAM,4/11/2022,TROUSER ASSEMBLY 2,MANAGER,9582435365,SEC 68 NOIDA,ACTIVE,TRUE',
    )

    expect(plan.errors).toEqual([])
    expect(plan.input).toMatchObject({
      employeeCode: '00000068',
      employeeName: 'MD RAJJAK ALAM',
      joiningDate: '2022-04-11',
      department: 'TROUSER ASSEMBLY 2',
      designation: 'MANAGER',
      phoneNumber: '9582435365',
    })
  })

  it('keeps the leading zeros on a code', () => {
    // They are what the office files by; a code read as a number is a
    // different employee.
    expect(rowFor('00000068,A,4/11/2022,,,,,ACTIVE,TRUE').input?.employeeCode).toBe('00000068')
  })

  it('restores the zeros the spreadsheet ate, and says so', () => {
    // Excel decides '00000068' is the number 68 and writes 68. It is not a
    // different employee; it is the same one with the zeros missing.
    const plan = rowFor('68,A,4/11/2022,,,,,ACTIVE,TRUE')

    expect(plan.errors).toEqual([])
    expect(plan.employeeCode).toBe('00000068')
    expect(plan.input?.employeeCode).toBe('00000068')
    expect(plan.paddedFrom).toBe('68')
    // A full code is left alone and not reported as padded.
    expect(rowFor('00000068,A,4/11/2022,,,,,ACTIVE,TRUE').paddedFrom).toBeUndefined()
    expect(looksTruncated('68')).toBe(true)
    expect(looksTruncated('00000068')).toBe(false)
    expect(looksTruncated('ASPS/9656')).toBe(false)
  })

  it('refuses a code that is not a number rather than guessing at it', () => {
    // Every code this company issues is eight digits. Letters mean the wrong
    // column, or another system's number - either way not something to pad.
    const plan = rowFor('ASPS/9656,A,4/11/2022,,,,,ACTIVE,TRUE')

    expect(plan.errors.join(' ')).toContain('not a number')
    expect(plan.input).toBeUndefined()
    expect(plan.paddedFrom).toBeUndefined()
  })

  it('normalises a code the way the company writes one', () => {
    expect(normaliseEmployeeCode('5696')).toEqual({ code: '00005696', paddedFrom: '5696' })
    expect(normaliseEmployeeCode(' 5696 ')).toEqual({ code: '00005696', paddedFrom: '5696' })
    expect(normaliseEmployeeCode('00005696')).toEqual({ code: '00005696' })
    expect(normaliseEmployeeCode('')).toEqual({ error: 'employee_code is empty' })
    expect(normaliseEmployeeCode('EMP001')).toMatchObject({ error: expect.stringContaining('not a number') })
    expect(normaliseEmployeeCode('123456789')).toMatchObject({ error: expect.stringContaining('longer than') })
  })

  it('imports the employee and drops a mobile number it cannot use', () => {
    // Eleven digits, twice in the real file. Losing a person from the master
    // over a mistyped phone number would be the worse answer.
    const plan = rowFor(
      '00005609,ASHA DEVI,4/2/2026,JACKET FRONT,ASSTT.OPERATER,80577679433,BEHLOLPUR NOIDA,ACTIVE,TRUE',
    )

    expect(plan.errors).toEqual([])
    expect(plan.input?.employeeName).toBe('ASHA DEVI')
    expect(plan.input?.phoneNumber).toBeUndefined()
    expect(plan.warnings.join(' ')).toContain('80577679433')
  })

  it('imports somebody with no mobile and no address at all', () => {
    const plan = rowFor('00010051,GAURAV KUMAR,5/8/2026,ADMIN,MERCHANDISER,,,ACTIVE,TRUE')

    expect(plan.errors).toEqual([])
    expect(plan.warnings).toEqual([])
    expect(plan.input?.employeeCode).toBe('00010051')
  })

  it('fails a row with no joining date, because every deadline hangs off it', () => {
    const plan = rowFor('00000068,MD RAJJAK ALAM,,TROUSER ASSEMBLY 2,MANAGER,,,ACTIVE,TRUE')

    expect(plan.input).toBeUndefined()
    expect(plan.errors.join(' ')).toContain('joining_date is empty')
  })

  it('fails a row whose date cannot be read, rather than inventing one', () => {
    const plan = rowFor('00000068,A,31/31/2022,,,,,ACTIVE,TRUE')

    expect(plan.input).toBeUndefined()
    expect(plan.errors.join(' ')).toContain('is not a date')
  })

  it('fails a row with no name', () => {
    expect(rowFor('00000068,,4/11/2022,,,,,ACTIVE,TRUE').errors.length).toBeGreaterThan(0)
  })

  it('refuses to half-import somebody who has already left', () => {
    // Recording an exit needs a resignation date and a last working day, and
    // this file carries neither.
    const plan = rowFor('00000068,A,4/11/2022,,,,,LEFT,FALSE')

    expect(plan.input).toBeUndefined()
    expect(plan.errors.join(' ')).toContain('LEFT')
  })

  it('treats an existing employee like any other, as the office asked', () => {
    // is_existing_employee is read and deliberately not acted on: their
    // deadlines run from their joining date like everybody else's.
    const older = rowFor('00000068,A,4/11/2022,,,,,ACTIVE,TRUE')
    const newer = rowFor('00000069,B,4/11/2022,,,,,ACTIVE,FALSE')

    expect(older.input?.joiningDate).toBe(newer.input?.joiningDate)
  })
})

describe('planning the whole file', () => {
  const plan = (existing: string[] = [], options = {}) =>
    planImport(rowsOf(FILE), new Set(existing), { format: 'mdy', ...options })

  it('imports everybody it can', () => {
    const result = plan()

    expect(result.create).toHaveLength(5)
    expect(result.fail).toHaveLength(0)
  })

  it('skips somebody who is already on the system', () => {
    const result = plan(['00006016'])

    expect(result.skip.map((row) => row.employeeCode)).toEqual(['00006016'])
    expect(result.create).toHaveLength(4)
    expect(result.skip[0]?.duplicate).toBe('in the database')
  })

  it('runs twice without making anybody twice', () => {
    // The second run sees the codes the first one wrote.
    const first = plan()
    const after = new Set(first.create.map((row) => row.employeeCode))

    const second = planImport(rowsOf(FILE), after, { format: 'mdy' })

    expect(second.create).toHaveLength(0)
    expect(second.skip).toHaveLength(5)
  })

  it('catches a code that appears twice in the file itself', () => {
    const doubled = [FILE, '00000068,SOMEBODY ELSE,1/1/2024,,,,,ACTIVE,TRUE'].join('\n')

    const result = planImport(rowsOf(doubled), new Set(), { format: 'mdy' })

    expect(result.create).toHaveLength(5)
    expect(result.skip[0]?.duplicate).toBe('earlier in this file')
  })

  it('does not let one bad row stop the rest', () => {
    const withBadRow = [FILE, '00009999,NO DATE HERE,,,,,,ACTIVE,TRUE'].join('\n')

    const result = planImport(rowsOf(withBadRow), new Set(), { format: 'mdy' })

    expect(result.fail).toHaveLength(1)
    expect(result.create).toHaveLength(5)
  })

  it('turns a dropped detail into a failed row when told to be strict', () => {
    const result = plan([], { strict: true })

    const asha = result.fail.find((row) => row.employeeCode === '00005609')
    expect(asha?.errors.join(' ')).toContain('--strict')
    expect(result.create).toHaveLength(4)
  })

  it('accounts for every row exactly once', () => {
    const result = plan(['00006016'])

    expect(result.create.length + result.skip.length + result.fail.length).toBe(
      result.rows.length,
    )
  })
})

describe('reading a sheet by position', () => {
  // What the import screen reads: code, name, joining date, in that order,
  // under whatever heading the person typed.
  const table = [
    ['Emp No', 'Worker Name', 'DOJ', 'Dept (ignored)'],
    ['5696', 'Ravi Kumar Gaur', '07/09/2026', 'Cutting'],
    ['', '', '', ''],
    ['00000068', 'MD RAJJAK ALAM', '11/04/2022'],
  ]

  it('maps the first three columns by position and ignores the rest', () => {
    const { header, rows } = readRowsByPosition(table)

    expect(header).toEqual(['Emp No', 'Worker Name', 'DOJ'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      line: 2,
      values: { employee_code: '5696', full_name: 'Ravi Kumar Gaur', joining_date: '07/09/2026' },
      cells: ['5696', 'Ravi Kumar Gaur', '07/09/2026'],
    })
    // A short row is padded to three cells, not dropped.
    expect(rows[1]?.cells).toEqual(['00000068', 'MD RAJJAK ALAM', '11/04/2022'])
  })

  it('skips a blank row and keeps the file line numbers honest', () => {
    const { rows } = readRowsByPosition(table)
    expect(rows.map((row) => row.line)).toEqual([2, 4])
  })

  it('feeds the plan exactly as the named reader does', () => {
    const { rows } = readRowsByPosition(table)
    const plan = planImport(rows, new Set(['00000068']), { format: 'dmy' })

    expect(plan.create.map((row) => row.employeeCode)).toEqual(['00005696'])
    expect(plan.create[0]?.paddedFrom).toBe('5696')
    expect(plan.create[0]?.input?.joiningDate).toBe('2026-09-07')
    expect(plan.skip.map((row) => row.duplicate)).toEqual(['in the database'])
  })

  it('reads an empty table as a header and nothing else', () => {
    expect(readRowsByPosition([])).toEqual({ header: [], rows: [] })
    expect(readRowsByPosition([['a', 'b', 'c']])).toEqual({ header: ['a', 'b', 'c'], rows: [] })
  })
})
