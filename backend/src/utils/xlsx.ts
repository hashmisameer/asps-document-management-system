import zlib from 'node:zlib'

/**
 * Reading a sheet out of an .xlsx file.
 *
 * An .xlsx is a zip of XML, and this reads exactly the two parts of it that a
 * data import needs: the shared string table and the first worksheet. No
 * formulas, no styles, no formatting - a cell is text, a number, or empty.
 *
 * WRITTEN HERE RATHER THAN INSTALLED. The office server has no route to a
 * registry, so every dependency is a file somebody has to carry to it, and the
 * two obvious libraries are a heavyweight workbook writer and a package whose
 * npm releases were abandoned. Node can already inflate a deflate stream; what
 * was missing was a hundred lines of zip directory and a small XML scan.
 *
 * If this ever needs to do more than read a rectangle of cells - merged cells,
 * multiple sheets, cell formats - that is the point to reach for a real
 * library instead of growing this one.
 */

/* -------------------------------------------------------------------------- */
/* The zip container                                                           */
/* -------------------------------------------------------------------------- */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50

/** Where the central directory starts, found by scanning back for its marker. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  // The comment at the end of a zip is at most 65535 bytes, so the marker is
  // within the last 64 kB plus the 22-byte record itself.
  const from = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at
  }
  throw new Error('This is not a zip file, so it is not an .xlsx either.')
}

/**
 * Every file in the archive, by name.
 *
 * Only the two compression methods a spreadsheet uses: stored, and deflate.
 * Anything else is reported rather than silently returning nothing.
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(end + 10)
  let at = buffer.readUInt32LE(end + 16)

  const entries = new Map<string, Buffer>()

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_FILE_HEADER) break

    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localHeaderAt = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)

    // The local header repeats the name and carries its own extra field, whose
    // length is often different from the central directory's.
    const localNameLength = buffer.readUInt16LE(localHeaderAt + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderAt + 28)
    const dataAt = localHeaderAt + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataAt, dataAt + compressedSize)

    if (method === 0) entries.set(name, Buffer.from(data))
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data))
    else throw new Error(`'${name}' uses an unsupported compression method (${method}).`)

    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/* -------------------------------------------------------------------------- */
/* The sheet                                                                   */
/* -------------------------------------------------------------------------- */

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity)
}

/**
 * The shared string table.
 *
 * Excel writes most text once here and points at it from the cells. A single
 * string can be split across several runs - <si><r><t>AB</t></r><r><t>C</t></r>
 * - when part of it was formatted differently, so every <t> in one <si> is
 * joined rather than only the first taken.
 */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []

  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    [...(item[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXml(text[1] ?? ''))
      .join(''),
  )
}

/** 'A' -> 0, 'Z' -> 25, 'AA' -> 26. The column half of a cell reference. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? ''
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/** One worksheet as rows of text, with gaps preserved as empty cells. */
export function readSheet(sheetXml: string, sharedStrings: readonly string[]): string[][] {
  const rows: string[][] = []

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []

    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)\/?>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''

      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1]
      const type = /t="([^"]+)"/.exec(attributes)?.[1]

      let value: string
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1')
        value = sharedStrings[index] ?? ''
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((text) => decodeXml(text[1] ?? ''))
          .join('')
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }

      // A cell that holds nothing is simply absent from the XML, so the column
      // its reference names is where it goes - not the next free slot.
      const at = reference ? columnIndex(reference) : cells.length
      while (cells.length < at) cells.push('')
      cells[at] = value
    }

    rows.push(cells)
  }

  return rows
}

/**
 * The first worksheet of a workbook, as rows of text.
 *
 * The first sheet by file name, which for every spreadsheet Excel writes is
 * the first sheet in the book. A workbook whose data is on the second tab is
 * not something this reads, and says so rather than importing the wrong tab.
 */
export function readXlsx(buffer: Buffer): string[][] {
  const entries = readZipEntries(buffer)

  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()

  const first = sheetNames[0]
  if (!first) throw new Error('That .xlsx has no worksheet in it.')

  const sheetXml = entries.get(first)?.toString('utf8') ?? ''
  const sharedStrings = readSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'))

  return readSheet(sheetXml, sharedStrings)
}
