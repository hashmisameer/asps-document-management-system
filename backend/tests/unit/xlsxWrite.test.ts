import { describe, expect, it } from 'vitest'
import {
  XLSX_MIME_TYPE,
  columnLetter,
  crc32,
  escapeXml,
  sheetName,
  toXlsx,
  utf8,
  zipStored,
  type XlsxColumn,
} from '@asps-dms/shared'
import { readXlsx, readZipEntries } from '../../src/utils/xlsx.js'

/**
 * The .xlsx writer, proved by the .xlsx reader.
 *
 * The writer lives in shared/ and the reader in the backend, and they were
 * written separately from the same specification. A file that goes through
 * both and comes back as the same table is a file Excel opens - the reader
 * takes the same zip directory and the same cell XML Excel does.
 *
 * The one thing that matters most is asserted most: an employee code written
 * as text comes back as the same text, zeros and all. That is the reason CSV
 * was retired.
 */

interface Row {
  code: string
  name: string
  joined: string
  pending: number | null
}

const COLUMNS: readonly XlsxColumn<Row>[] = [
  { header: 'Employee ID', value: (r) => r.code },
  { header: 'Name', value: (r) => r.name },
  { header: 'Joined', value: (r) => r.joined },
  { header: 'Documents pending', value: (r) => r.pending, kind: 'number' },
]

const ROWS: Row[] = [
  { code: '00005696', name: 'Ravi Kumar Gaur', joined: '07/09/2026', pending: 3 },
  { code: '00000068', name: 'Anita & Co <Test>', joined: '11/04/2022', pending: 0 },
  { code: 'ASPS/9656', name: '=SUM(A1:A9)', joined: '-', pending: null },
]

const FIXED_DATE = new Date(2026, 8, 17, 10, 30, 0)

describe('the .xlsx writer', () => {
  it('writes a workbook the reader reads back as the same table', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))

    expect(readXlsx(file)).toEqual([
      ['Employee ID', 'Name', 'Joined', 'Documents pending'],
      ['00005696', 'Ravi Kumar Gaur', '07/09/2026', '3'],
      ['00000068', 'Anita & Co <Test>', '11/04/2022', '0'],
      ['ASPS/9656', '=SUM(A1:A9)', '-'],
    ])
  })

  it('keeps a zero-padded code as text, which is the whole point', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))
    const sheet = readZipEntries(file).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''

    // An inline string cell, never a <v> number: Excel keeps the zeros because
    // the cell says it is text, not because of anything Excel guesses.
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">00005696</t></is></c>')
    expect(sheet).not.toContain('<v>5696</v>')
  })

  it('writes a genuine count as a number cell, and nothing for a missing one', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))
    const sheet = readZipEntries(file).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''

    expect(sheet).toContain('<c r="D2"><v>3</v></c>')
    expect(sheet).toContain('<c r="D3"><v>0</v></c>')
    // Null writes no cell: the reader sees a short row, Excel a blank.
    expect(sheet).not.toContain('r="D4"')
  })

  it('escapes markup in a value rather than letting it break the file', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))
    const sheet = readZipEntries(file).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''

    expect(sheet).toContain('Anita &amp; Co &lt;Test&gt;')
    expect(sheet).not.toContain('<Test>')
  })

  it('shows a value that looks like a formula, and does not make it one', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))
    const sheet = readZipEntries(file).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''

    // Inline text. A formula lives in <f>, and there is none.
    expect(sheet).toContain('<t xml:space="preserve">=SUM(A1:A9)</t>')
    expect(sheet).not.toContain('<f>')
    // And no CSV-style apostrophe was prefixed to it.
    expect(readXlsx(file)[3]?.[1]).toBe('=SUM(A1:A9)')
  })

  it('drops the control characters XML forbids, and keeps a tab and a newline', () => {
    expect(escapeXml(`a${String.fromCharCode(1)}b${String.fromCharCode(0x1f)}c`)).toBe('abc')
    expect(escapeXml('line\nbreak\ttab')).toBe('line\nbreak\ttab')
    expect(escapeXml('"quoted" & <tag>')).toBe('&quot;quoted&quot; &amp; &lt;tag&gt;')
  })

  it('packages the five parts Excel expects, all stored', () => {
    const file = Buffer.from(toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE))
    const entries = readZipEntries(file)

    expect([...entries.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
    expect(entries.get('xl/workbook.xml')?.toString('utf8')).toContain('<sheet name="Employees"')
    // The local header says stored: method 0 at offset 8.
    expect(file.readUInt16LE(8)).toBe(0)
    // And the magic is a zip's.
    expect(file.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  })

  it('names the sheet within what Excel allows', () => {
    expect(sheetName('Employees')).toBe('Employees')
    expect(sheetName('PF Form / Form 11')).toBe('PF Form Form 11')
    expect(sheetName('A very long document name that runs past thirty-one characters').length).toBeLessThanOrEqual(31)
    expect(sheetName('???')).toBe('Sheet1')
  })

  it('writes the same bytes for the same input, so a file can be diffed', () => {
    const a = toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE)
    const b = toXlsx(ROWS, COLUMNS, 'Employees', FIXED_DATE)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('handles an empty table: a heading row and nothing else', () => {
    const file = Buffer.from(toXlsx([], COLUMNS, 'Employees', FIXED_DATE))
    expect(readXlsx(file)).toEqual([['Employee ID', 'Name', 'Joined', 'Documents pending']])
  })
})

describe('the pieces underneath', () => {
  it('encodes UTF-8 the way Node does', () => {
    for (const text of ['plain', 'Priya Sharma', 'सेवा कार्ड', 'émoji 🙂', '']) {
      expect(Buffer.from(utf8(text))).toEqual(Buffer.from(text, 'utf8'))
    }
  })

  it('computes the CRC-32 a zip reader checks', () => {
    // The standard check value: crc32("123456789") = 0xCBF43926.
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('names columns the way Excel does', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
  })

  it('zips entries the reader can list and open', () => {
    const zip = Buffer.from(
      zipStored(
        [
          { name: 'a.txt', data: utf8('hello') },
          { name: 'dir/b.txt', data: utf8('world') },
        ],
        FIXED_DATE,
      ),
    )
    const entries = readZipEntries(zip)
    expect(entries.get('a.txt')?.toString('utf8')).toBe('hello')
    expect(entries.get('dir/b.txt')?.toString('utf8')).toBe('world')
  })

  it('names the file type Excel registers', () => {
    expect(XLSX_MIME_TYPE).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })
})
