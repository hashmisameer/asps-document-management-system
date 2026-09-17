import { XLSX_MIME_TYPE, toXlsx, type XlsxColumn } from '@asps-dms/shared'
import { saveBlob } from './download.js'

/**
 * Downloading a report as an .xlsx file.
 *
 * Built in the browser from rows the screen already holds - every row the
 * filters match, or the selection where there is one - so what is downloaded is
 * exactly what was being looked at, and there is no second query that could
 * answer slightly differently. The writer itself is in shared/ and is proved
 * by the server's reader in the backend tests.
 *
 * .xlsx and not CSV: an employee code is '00005696', and Excel throws the zeros
 * away when it opens a CSV. An .xlsx cell carries its type, so a code written
 * as text stays text.
 */

export type { XlsxColumn }

/** Offers the workbook as a file, named for the report and the day it was taken. */
export function downloadXlsx<T>(
  fileName: string,
  sheet: string,
  rows: readonly T[],
  columns: readonly XlsxColumn<T>[],
): void {
  // Copied into a fresh buffer: a Blob wants bytes it can own, and the
  // typed-array view the writer returns may sit on a larger one.
  const bytes = new Uint8Array(toXlsx(rows, columns, sheet))
  saveBlob(new Blob([bytes], { type: XLSX_MIME_TYPE }), fileName)
}
