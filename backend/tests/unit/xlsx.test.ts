import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { columnIndex, readSheet, readXlsx, readZipEntries } from '../../src/utils/xlsx.js'
import { parseImportDate, readRows, readTable } from '../../src/services/employeeImport.service.js'

/**
 * Reading an .xlsx without a library.
 *
 * The workbooks below are built here, entry by entry, so what is under test is
 * the real reader against a real zip rather than a mock of one. Both storage
 * methods a spreadsheet uses are covered: stored, and deflated.
 */

/** A zip file, built by hand. The reader ignores CRCs, so they are left at zero. */
function zip(files: { name: string; content: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.content, 'utf8')
    const data = file.deflate ? zlib.deflateRawSync(raw) : raw
    const method = file.deflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(0, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += 30 + name.length + data.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}

/** A workbook whose first sheet holds the given rows of text. */
function workbook(rows: string[][], options: { deflate?: boolean } = {}): Buffer {
  const strings: string[] = []
  const indexOf = (value: string): number => {
    const at = strings.indexOf(value)
    if (at !== -1) return at
    strings.push(value)
    return strings.length - 1
  }

  const letters = (column: number): string => {
    let name = ''
    let n = column + 1
    while (n > 0) {
      const remainder = (n - 1) % 26
      name = String.fromCharCode(65 + remainder) + name
      n = Math.floor((n - remainder) / 26)
    }
    return name
  }

  const sheetRows = rows
    .map((cells, row) => {
      const xml = cells
        .map((value, column) => {
          if (value === '') return ''
          const reference = `${letters(column)}${row + 1}`
          return /^[0-9]+$/.test(value)
            ? `<c r="${reference}"><v>${value}</v></c>`
            : `<c r="${reference}" t="s"><v>${indexOf(value)}</v></c>`
        })
        .join('')
      return `<row r="${row + 1}">${xml}</row>`
    })
    .join('')

  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return zip([
    {
      name: 'xl/sharedStrings.xml',
      content: `<sst>${strings.map((value) => `<si><t>${escape(value)}</t></si>`).join('')}</sst>`,
      deflate: options.deflate,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
      deflate: options.deflate,
    },
  ])
}

const HEADER = [
  'employee_code',
  'full_name',
  'joining_date',
  'department',
  'designation',
  'mobile',
  'address',
  'employment_status',
  'is_existing_employee',
]

describe('the zip container', () => {
  it('reads a stored entry', () => {
    const entries = readZipEntries(zip([{ name: 'a.txt', content: 'hello' }]))

    expect(entries.get('a.txt')?.toString()).toBe('hello')
  })

  it('reads a deflated entry, which is what Excel writes', () => {
    const entries = readZipEntries(zip([{ name: 'a.txt', content: 'hello', deflate: true }]))

    expect(entries.get('a.txt')?.toString()).toBe('hello')
  })

  it('says plainly when the file is not a zip at all', () => {
    expect(() => readZipEntries(Buffer.from('employee_code,full_name\n1,A'))).toThrow(/not a zip/i)
  })
})

describe('reading cells', () => {
  it('names columns the way a spreadsheet does', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('B2')).toBe(1)
    expect(columnIndex('Z9')).toBe(25)
    expect(columnIndex('AA1')).toBe(26)
  })

  it('leaves a gap where an empty cell was', () => {
    // An empty cell is simply absent from the XML, so its reference is what
    // says where the next one belongs - not the order they appear in.
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'

    expect(readSheet(sheet, ['first', 'third'])).toEqual([['first', '', 'third']])
  })

  it('joins a string Excel split into runs', () => {
    // One string formatted in two ways is stored as two runs of one entry.
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
    const shared = ['ASSTT.OPERATER']

    expect(readSheet(sheet, shared)).toEqual([['ASSTT.OPERATER']])
  })

  it('reads a number as the text it shows', () => {
    expect(readSheet('<row r="1"><c r="A1"><v>9582435365</v></c></row>', [])).toEqual([
      ['9582435365'],
    ])
  })

  it('decodes the entities XML must escape', () => {
    const sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>R &amp; D</t></is></c></row>'

    expect(readSheet(sheet, [])).toEqual([['R & D']])
  })
})

describe('a whole workbook', () => {
  const rows = [
    HEADER,
    ['00000068', 'MD RAJJAK ALAM', '44662', 'TROUSER ASSEMBLY 2', 'MANAGER', '', '', 'ACTIVE', 'TRUE'],
    ['00010051', 'GAURAV KUMAR', '46150', 'ADMIN', 'MERCHANDISER', '', '', 'ACTIVE', 'TRUE'],
  ]

  it('reads the first sheet as a table', () => {
    expect(readXlsx(workbook(rows))).toEqual(rows.map((row) => row.map((cell) => cell)))
  })

  it('reads it the same when Excel has compressed it', () => {
    expect(readXlsx(workbook(rows, { deflate: true }))[1]?.[1]).toBe('MD RAJJAK ALAM')
  })

  it('feeds the same import as a CSV would', () => {
    // The header, the validation and the duplicate check have no idea which
    // kind of file they came from.
    const { rows: parsed, missingColumns } = readRows(readTable('master.xlsx', workbook(rows)))

    expect(missingColumns).toEqual([])
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.values.employee_code).toBe('00000068')
    expect(parsed[0]?.values.full_name).toBe('MD RAJJAK ALAM')
  })

  it('reads a date Excel stored as a number', () => {
    // A date cell holds a serial, and the format that makes it look like a
    // date lives elsewhere in the file.
    expect(parseImportDate('44662', 'mdy')).toBe('2022-04-11')
    expect(parseImportDate('46150', 'mdy')).toBe('2026-05-08')
  })

  it('does not read an employee code as a date', () => {
    // Six digits and up is out of the range a joining date can be in, so a
    // column that has wandered fails loudly instead of inventing a year.
    expect(parseImportDate('00000068', 'mdy')).toBeNull()
    expect(parseImportDate('123456', 'mdy')).toBeNull()
  })

  it('refuses a file it does not know how to read', () => {
    expect(() => readTable('master.pdf', Buffer.from(''))).toThrow(/\.xlsx or \.csv/)
  })
})
