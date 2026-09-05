import { describe, expect, it } from 'vitest'
import { toCsv } from '../../src/lib/csv.js'

/**
 * What a report becomes once it is opened in Excel.
 *
 * Two of these are not cosmetic. A comma in a cell splits one row into several
 * columns, and a leading '=' makes Excel run the cell as a formula.
 */

const columns = [
  { header: 'Name', value: (r: { name: string; note: string }) => r.name },
  { header: 'Note', value: (r: { name: string; note: string }) => r.note },
]

describe('toCsv', () => {
  it('writes a header row and one row per record', () => {
    const csv = toCsv([{ name: 'Ravi Kumar', note: 'ok' }], columns)
    expect(csv).toContain('Name,Note')
    expect(csv).toContain('Ravi Kumar,ok')
  })

  it('quotes a cell containing a comma', () => {
    // The outstanding-documents column is a comma-separated list, so without
    // this every such row would break into a dozen columns.
    const csv = toCsv([{ name: 'Ravi Kumar', note: 'Aadhaar Card, PAN Card' }], columns)
    expect(csv).toContain('"Aadhaar Card, PAN Card"')
  })

  it('doubles the quotes inside a quoted cell', () => {
    const csv = toCsv([{ name: 'Ravi "Bob" Kumar', note: 'x' }], columns)
    expect(csv).toContain('"Ravi ""Bob"" Kumar"')
  })

  it('keeps a newline inside one cell rather than starting a row', () => {
    const csv = toCsv([{ name: 'Line one\nLine two', note: 'x' }], columns)
    expect(csv).toContain('"Line one\nLine two"')
  })

  it('stops Excel treating a cell as a formula', () => {
    // A value beginning with =, +, - or @ is executed when the file is opened.
    // A name or a note is data, and must arrive as data.
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      const csv = toCsv([{ name: dangerous, note: 'x' }], columns)
      expect(csv, dangerous).toContain(`'${dangerous}`)
    }
  })

  it('writes an empty cell for a missing value, not "null"', () => {
    const csv = toCsv([{ name: 'Ravi', note: null as unknown as string }], columns)
    expect(csv).toContain('Ravi,')
    expect(csv).not.toContain('null')
  })

  it('starts with a BOM, so Excel reads it as UTF-8', () => {
    // Without it an employee name with an accent arrives mangled - the sort of
    // thing nobody reports and everybody notices.
    expect(toCsv([], columns).charCodeAt(0)).toBe(0xfeff)
  })
})
