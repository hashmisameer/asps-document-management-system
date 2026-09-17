/**
 * Writing a table out as an .xlsx file.
 *
 * The mirror of backend/src/utils/xlsx.ts, which reads one. An .xlsx is a zip
 * of XML, and this writes exactly the parts a spreadsheet needs to open: the
 * package manifest, the workbook, and one worksheet. No styles, no shared
 * strings, no formulas.
 *
 * WRITTEN HERE RATHER THAN INSTALLED, for the reason the reader was: the office
 * server has no route to a registry, and the obvious libraries are heavyweight.
 * It lives in shared/ and uses nothing from Node or the DOM - its own UTF-8, its
 * own CRC - so the browser builds the file from rows it already holds, and the
 * server's test reads it back with the reader.
 *
 * WHY NOT CSV. An employee code is '00005696'. A CSV holds that correctly and
 * Excel throws the zeros away on opening it; and on a machine whose list
 * separator is a semicolon every row lands in one column. An .xlsx cell carries
 * its type, so a code written as text stays text and columns stay columns.
 *
 * Every string is an INLINE STRING cell, and a formula only ever lives in an
 * <f> element, so a value beginning with '=' is shown and never evaluated. The
 * guard CSV needed against that is not needed here. What is needed is XML
 * escaping, and the removal of the control characters XML forbids.
 *
 * Zip entries are STORED, not deflated. The file is several times larger than
 * it could be - a few hundred kilobytes for every employee - and in exchange
 * there is no compression code to carry, and nothing that differs between the
 * browser and the server.
 */

/**
 * One column: a heading, how to read the value from a row, and what kind of
 * cell to write it in.
 *
 * 'text' is the default and the safe one. 'number' is for genuine counts only:
 * a digit string written as a number is exactly how a code loses its zeros, so
 * a column has to ask for it.
 */
export interface XlsxColumn<T> {
  header: string
  value: (row: T) => unknown
  kind?: 'text' | 'number'
  /** Width in characters. Left out, Excel's default of about eight clips names. */
  width?: number
}

/* -------------------------------------------------------------------------- */
/* Bytes                                                                       */
/* -------------------------------------------------------------------------- */

/** UTF-8, by hand: shared/ has neither TextEncoder's types nor Buffer. */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 as zip defines it, which is what a reader checks an entry against. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/* -------------------------------------------------------------------------- */
/* Zip                                                                         */
/* -------------------------------------------------------------------------- */

interface ZipEntry {
  name: string
  data: Uint8Array
}

/** MS-DOS date and time, which is what a zip header carries. */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  }
}

/**
 * A zip archive of stored entries.
 *
 * Local header, data, local header, data ... then the central directory that
 * lists them again, then the record that says where the directory starts. The
 * reader finds that record by scanning back from the end, which is why nothing
 * may follow it.
 */
export function zipStored(entries: readonly ZipEntry[], when: Date = new Date()): Uint8Array {
  const { date, time } = dosDateTime(when)
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0

  const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff]
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]

  for (const entry of entries) {
    const name = utf8(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = Uint8Array.from([
      ...u32(0x04034b50), // local file header
      ...u16(20), // version needed
      ...u16(0x0800), // flags: names are UTF-8
      ...u16(0), // method: stored
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0), // extra length
      ...name,
    ])
    parts.push(local, entry.data)

    directory.push(
      Uint8Array.from([
        ...u32(0x02014b50), // central directory header
        ...u16(20), // version made by
        ...u16(20), // version needed
        ...u16(0x0800),
        ...u16(0),
        ...u16(time),
        ...u16(date),
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(name.length),
        ...u16(0), // extra
        ...u16(0), // comment
        ...u16(0), // disk
        ...u16(0), // internal attributes
        ...u32(0), // external attributes
        ...u32(offset),
        ...name,
      ]),
    )
    offset += local.length + size
  }

  const directoryStart = offset
  const directoryLength = directory.reduce((total, part) => total + part.length, 0)
  const end = Uint8Array.from([
    ...u32(0x06054b50), // end of central directory
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(directoryLength),
    ...u32(directoryStart),
    ...u16(0), // comment length
  ])

  const total = offset + directoryLength + end.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of [...parts, ...directory, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* The workbook                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Text as XML may carry it.
 *
 * The five markup characters are escaped, and the control characters XML 1.0
 * forbids outright are dropped: a name pasted in with a stray character in it
 * would otherwise make a file Excel refuses to open at all.
 */
export function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA'. The column half of a cell reference. */
export function columnLetter(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function textCell(reference: string, value: string): string {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

/**
 * A number cell, or nothing for a value that is not one.
 *
 * Null, an empty string and NaN write no cell at all - the reader treats an
 * absent cell as empty, and Excel shows a blank rather than a zero somebody
 * did not enter.
 */
function numberCell(reference: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return textCell(reference, String(value))
  return `<c r="${reference}"><v>${number}</v></c>`
}

/**
 * A sheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ].
 * Falls back to 'Sheet1' rather than writing a name that stops the file opening.
 */
export function sheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim()
  return cleaned || 'Sheet1'
}

function worksheetXml<T>(rows: readonly T[], columns: readonly XlsxColumn<T>[]): string {
  const cols = columns
    .map((column, index) => {
      const width = column.width ?? Math.min(60, Math.max(10, column.header.length + 2))
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
    })
    .join('')

  const lines: string[] = []
  lines.push(
    '<row r="1">' +
      columns.map((column, c) => textCell(`${columnLetter(c)}1`, column.header)).join('') +
      '</row>',
  )

  rows.forEach((row, r) => {
    const rowNumber = r + 2
    const cells = columns
      .map((column, c) => {
        const reference = `${columnLetter(c)}${rowNumber}`
        const value = column.value(row)
        if (column.kind === 'number') return numberCell(reference, value)
        if (value === null || value === undefined) return ''
        return textCell(reference, String(value))
      })
      .join('')
    lines.push(`<row r="${rowNumber}">${cells}</row>`)
  })

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<cols>${cols}</cols>` +
    `<sheetData>${lines.join('')}</sheetData>` +
    '</worksheet>'
  )
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>'

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>'

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>'

function workbookXml(name: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  )
}

export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * A table as the bytes of an .xlsx file: a heading row, then one row per record.
 *
 * `sheet` names the tab. It is cut to what Excel allows; the file name is the
 * caller's business.
 */
export function toXlsx<T>(
  rows: readonly T[],
  columns: readonly XlsxColumn<T>[],
  sheet: string,
  when: Date = new Date(),
): Uint8Array {
  return zipStored(
    [
      { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
      { name: '_rels/.rels', data: utf8(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: utf8(workbookXml(sheetName(sheet))) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(worksheetXml(rows, columns)) },
    ],
    when,
  )
}
