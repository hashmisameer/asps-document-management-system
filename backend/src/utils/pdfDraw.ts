import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

/**
 * The drawing this system's printed pages are built from.
 *
 * Two documents come out of this API on paper - an employee's form and a
 * chase list for one document type - and they are read side by side by the same
 * people. Sharing the primitives is what keeps them looking like they came from
 * the same office: the same greys, the same dates, the same footer saying who
 * printed the sheet and which page of how many it is.
 *
 * Layout stays with each document. What lives here is everything that would
 * otherwise be written twice and drift once.
 */

/** A4, in PDF points. */
export const A4_PORTRAIT = { width: 595.28, height: 841.89 }
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 }

export const INK = rgb(0.09, 0.11, 0.15)
export const MUTED = rgb(0.42, 0.45, 0.5)
export const RULE = rgb(0.78, 0.8, 0.83)
export const HEADER_FILL = rgb(0.93, 0.94, 0.95)
/** Rows that need to stand out are tinted, not coloured: this is printed in black and white. */
export const ROW_TINT = rgb(0.88, 0.89, 0.9)

/** An empty value reads as a dash, so the row still says the field exists. */
export const DASH = '—'

export interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

export interface PrintMeta {
  generatedAt: Date
  /** The signed-in user's name, printed in the footer. */
  generatedBy: string
}

/**
 * A document being drawn, and where on it the next thing goes.
 *
 * `y` is the height the next thing is drawn under, counting down from the top
 * of the page. Every helper here that draws something moves it.
 */
export interface Sheet {
  pdf: PDFDocument
  fonts: Fonts
  page: PDFPage
  y: number
  size: { width: number; height: number }
  margin: number
  contentWidth: number
  /** Kept clear at the foot of every page for the generated-by line. */
  footerSpace: number
}

export async function createSheet(options: {
  size: { width: number; height: number }
  margin: number
  footerSpace?: number
}): Promise<Sheet> {
  const pdf = await PDFDocument.create()
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  }

  const sheet: Sheet = {
    pdf,
    fonts,
    page: pdf.addPage([options.size.width, options.size.height]),
    y: options.size.height - options.margin,
    size: options.size,
    margin: options.margin,
    contentWidth: options.size.width - options.margin * 2,
    footerSpace: options.footerSpace ?? 38,
  }
  return sheet
}

/** Starts a fresh page and puts the cursor at the top of it. */
export function newPage(sheet: Sheet): void {
  sheet.page = sheet.pdf.addPage([sheet.size.width, sheet.size.height])
  sheet.y = sheet.size.height - sheet.margin
}

/** Whether `needed` points are still free above the footer. */
export function fits(sheet: Sheet, needed: number): boolean {
  return sheet.y - needed >= sheet.margin + sheet.footerSpace
}

export function rule(sheet: Sheet, gapAbove: number, gapBelow: number): void {
  sheet.y -= gapAbove
  sheet.page.drawLine({
    start: { x: sheet.margin, y: sheet.y },
    end: { x: sheet.margin + sheet.contentWidth, y: sheet.y },
    thickness: 0.7,
    color: RULE,
  })
  sheet.y -= gapBelow
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** The printable characters WinAnsi carries above Latin-1: quotes, dashes, the euro. */
const WIN_ANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ' + '‘’“”•–—˜™š›œžŸ')

/**
 * Characters the standard fonts can actually encode.
 *
 * pdf-lib's built-in fonts are WinAnsi, and asking one to draw a character
 * outside that set THROWS - so one employee whose address was typed in
 * Devanagari would fail a whole print, including the other nineteen people in
 * it. Anything unencodable becomes a question mark: visibly missing on the page,
 * where somebody can correct it, rather than a request that dies.
 */
export function printable(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    const encodable =
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_EXTRAS.has(character)
    out += encodable ? character : '?'
  }
  return out
}

export function widthOf(text: string, font: PDFFont, size: number): number {
  return font.widthOfTextAtSize(printable(text), size)
}

/** Breaks text to fit a column, on words where it can and mid-word where it must. */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (widthOf(candidate, font, size) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)

      // A single word wider than the column - a run-on address, an email - is
      // cut rather than allowed to run off the edge of the paper.
      line = word
      while (widthOf(line, font, size) > maxWidth && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && widthOf(line.slice(0, cut), font, size) > maxWidth) cut -= 1
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line)
  }

  return lines.length > 0 ? lines : ['']
}

/** As much of `text` as fits in one line of `maxWidth`, with an ellipsis if it was cut. */
export function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (widthOf(text, font, size) <= maxWidth) return text

  let cut = text.length
  while (cut > 1 && widthOf(`${text.slice(0, cut)}...`, font, size) > maxWidth) cut -= 1
  return `${text.slice(0, cut)}...`
}

export type Colour = ReturnType<typeof rgb>

/** One line of text, with anything unencodable already taken out of it. */
export function draw(
  page: PDFPage,
  text: string,
  options: { x: number; y: number; font: PDFFont; size: number; color?: Colour },
): void {
  page.drawText(printable(text), {
    x: options.x,
    y: options.y,
    font: options.font,
    size: options.size,
    color: options.color ?? INK,
  })
}

/** Right-aligned, for a page number, a count, and anything else that hangs off an edge. */
export function drawRight(
  page: PDFPage,
  text: string,
  options: { right: number; y: number; font: PDFFont; size: number; color?: Colour },
): void {
  draw(page, text, { ...options, x: options.right - widthOf(text, options.font, options.size) })
}

/* -------------------------------------------------------------------------- */
/* Dates and names                                                             */
/* -------------------------------------------------------------------------- */

/**
 * '2026-09-01' -> '01/09/2026', the way the company writes dates on its forms.
 *
 * Taken apart as a string rather than parsed into a Date: a date-only value put
 * through a timezone is a joining date that prints a day out. An ISO timestamp
 * is accepted too - only the date half of it is read.
 */
export function formatDate(dateOnly: string | null | undefined): string {
  if (!dateOnly) return DASH
  const [year, month, day] = dateOnly.slice(0, 10).split('-')
  return year && month && day ? `${day}/${month}/${year}` : DASH
}

/** The moment a sheet was produced, in the server's own time - the office's. */
export function formatTimestamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/** 'YYYY-MM-DD' for a file name, from the printer's own calendar rather than UTC. */
export function fileNameDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * A word reduced to what a Content-Disposition header and a Windows file system
 * agree on. Case is left alone; the caller decides that.
 */
export function fileNamePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/* -------------------------------------------------------------------------- */
/* The footer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The footer, drawn over every page once the last one exists.
 *
 * Last because 'Page 3 of 20' cannot be written until there is a 20, and a
 * sheet saying which of how many is the only way somebody holding a stack of
 * them can tell that one is missing.
 */
export function drawFooters(sheet: Sheet, meta: PrintMeta): void {
  const pages = sheet.pdf.getPages()
  const right = sheet.margin + sheet.contentWidth

  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: sheet.margin, y: sheet.margin + 20 },
      end: { x: right, y: sheet.margin + 20 },
      thickness: 0.5,
      color: RULE,
    })

    draw(page, `Generated ${formatTimestamp(meta.generatedAt)} by ${meta.generatedBy}`, {
      x: sheet.margin,
      y: sheet.margin + 8,
      font: sheet.fonts.regular,
      size: 8,
      color: MUTED,
    })

    drawRight(page, `Page ${index + 1} of ${pages.length}`, {
      right,
      y: sheet.margin + 8,
      font: sheet.fonts.regular,
      size: 8,
      color: MUTED,
    })
  })
}

/** The finished document, as bytes to send. */
export async function toBuffer(sheet: Sheet): Promise<Buffer> {
  return Buffer.from(await sheet.pdf.save())
}
