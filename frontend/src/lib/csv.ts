import { saveBlob } from './download.js'

/**
 * Downloading a report as CSV.
 *
 * Built in the browser from rows already on screen rather than asked of the
 * server: what is downloaded is then exactly what was being looked at, filters
 * and all, and there is no second query that could answer slightly differently.
 */

/**
 * Escapes one value for a CSV cell.
 *
 * Quotes anything containing a comma, a quote or a newline, and doubles the
 * quotes inside it. The outstanding-documents column is a comma-separated list,
 * so this is not a theoretical case: without it every such row would split into
 * a dozen columns in Excel.
 *
 * A leading =, +, - or @ is prefixed with a quote. Excel treats those as the
 * start of a FORMULA, so a name or note beginning with one becomes something
 * the spreadsheet tries to execute when the file is opened.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** Excel needs this to read the file as UTF-8; by codepoint, so the source has
    no invisible character sitting in a string literal. */
const BOM = String.fromCharCode(0xfeff)

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => escapeCell(column.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(column.value(row))).join(','))
  }
  // CRLF and a BOM: Excel on Windows opens the file as UTF-8 and keeps the
  // rows apart. Without the BOM an employee name with an accent arrives
  // mangled, which is the sort of thing nobody reports and everybody notices.
  return BOM + lines.join('\r\n') + '\r\n'
}

/** Offers the CSV as a file, named for the report and the day it was taken. */
export function downloadCsv(filename: string, csv: string): void {
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename)
}
