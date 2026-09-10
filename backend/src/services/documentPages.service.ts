import { PDFDocument, type PDFPage } from 'pdf-lib'
import sharp from 'sharp'
import { logger } from '../utils/logger.js'
import {
  A4_PORTRAIT,
  MUTED,
  RULE,
  draw,
  drawRight,
  formatTimestamp,
  type PrintMeta,
  type Sheet,
} from '../utils/pdfDraw.js'

/**
 * Putting an employee's filed documents into a PDF that is being built.
 *
 * Used by the printed employee file - their details, and then this. It is a
 * module of its own because none of it is about the details page: it is about
 * what happens to a scan somebody uploaded two years ago when it has to come
 * back out again.
 *
 * THE DOCUMENTS THEMSELVES ARE REPRODUCED UNTOUCHED, and they run straight on
 * from one another. No page number, no footer, no separator sheet announcing
 * what comes next: a document that comes out of here is the document as it was
 * filed, and drawOwnFooters signs only the pages the caller made before this
 * was called.
 *
 * The SIGNED copy is taken where there is one, exactly as downloading a single
 * document does, so what comes out shows the signatures the office holds.
 */

const MARGIN = 42

export interface DocumentFile {
  /**
   * Read when the document's turn comes, not before.
   *
   * Ten scanned documents is a hundred megabytes of paper, and reading them all
   * up front would hold every one of them in memory for as long as the slowest
   * takes to render. One at a time, the raw file is finished with as soon as
   * its pages are in - what stays is the PDF being built, which has to.
   */
  read: () => Promise<Buffer>
  mimeType: string
  /** The processed copy, which carries the signatures. Always a PDF. */
  isSigned: boolean
}

export interface DocumentEntry {
  documentName: string
  isMandatory: boolean
  uploadedAt: string | null
  uploadedByName: string | null
  file: DocumentFile
}

/* -------------------------------------------------------------------------- */
/* The documents themselves                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which pages of a filed PDF have anything on them.
 *
 * WHY THIS EXISTS: documents arrive with trailing blank pages - the company's
 * appointment letter has an empty third page - and a file bound for an
 * inspector should not carry them.
 *
 * WHAT COUNTS AS BLANK, and the rule is deliberately timid: a page is dropped
 * only when it draws NOTHING and carries no readable character. Any image, any
 * line, any filled shape, any word - the page stays. A signature, a stamp, a
 * pencil initial in the corner: all of those are drawing operations, and one is
 * enough.
 *
 * WHAT THIS CANNOT DO, and it is worth knowing: a photographed or scanned blank
 * sheet is an IMAGE of white paper, and to this - as to any reader of the file's
 * structure - that is a page with a picture on it. It stays. Catching those
 * would mean rendering every page and judging it by its pixels, which is how a
 * faint pencil signature gets thrown away.
 *
 * A document this cannot inspect keeps every page. Failing to read a file is
 * never a reason to remove anything from it.
 */
async function contentfulPageIndices(data: Buffer, pageCount: number): Promise<number[]> {
  const all = Array.from({ length: pageCount }, (_, index) => index)

  try {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // The operators that put something on the page, by name. Built from pdf.js
    // rather than listed by hand so a version that adds one is covered: every
    // painting, filling, stroking and shading operator matches, and the
    // 'setFillColor'-style operators that only choose a colour do not.
    const inkOps = new Set<number>()
    for (const [name, code] of Object.entries(OPS)) {
      if (!name.startsWith('set') && /paint|fill|stroke|shading/i.test(name)) {
        inkOps.add(code as number)
      }
    }

    const pdf = await getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise

    try {
      const keep: number[] = []

      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number)

        const operators = await page.getOperatorList()
        const draws = operators.fnArray.some((code) => inkOps.has(code))

        if (draws) {
          keep.push(number - 1)
          continue
        }

        const content = await page.getTextContent()
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
        if (text.trim().length > 0) keep.push(number - 1)
      }

      // Never hand back nothing. A document every page of which reads as blank
      // is far more likely to be one this could not understand than a file with
      // no content at all, and dropping the lot would lose a document silently.
      return keep.length > 0 ? keep : all
    } finally {
      await pdf.destroy()
    }
  } catch (error) {
    logger.warn({ err: error }, 'Could not inspect a PDF for blank pages; keeping every page')
    return all
  }
}

/**
 * 200 dpi on an A4 page.
 *
 * What a printer will actually put on the paper, and past what a screen can
 * show. A twelve-megapixel photograph of a service card carries none of that
 * detail through printing, and embedding it whole is how a file of ten
 * documents becomes a hundred megabytes that a mail server refuses.
 */
const IMAGE_MAX = { width: 1654, height: 2339 }

/**
 * Any accepted image, as something a PDF can hold - and no larger than a page.
 *
 * Every format goes through the same path rather than PNG and JPEG passing
 * through untouched, for three reasons: WEBP and TIFF cannot be embedded at all
 * and have to be converted anyway; a phone photograph carries its orientation
 * in EXIF, which pdf-lib does not read, so a card photographed in portrait
 * would otherwise arrive on its side; and the resize is what keeps ten scans
 * inside a file somebody can email.
 */
async function asEmbeddable(data: Buffer): Promise<Buffer> {
  return sharp(data)
    .rotate() // no argument: apply whatever the EXIF orientation says
    .resize({ ...IMAGE_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
}

/**
 * One image, on a page of its own.
 *
 * Fitted to A4 rather than given a page its own size, so a PDF form and three
 * phone photographs print on one stack of paper.
 */
async function addImagePage(sheet: Sheet, data: Buffer): Promise<void> {
  const image = await sheet.pdf.embedJpg(await asEmbeddable(data))

  const page = sheet.pdf.addPage([A4_PORTRAIT.width, A4_PORTRAIT.height])
  const maxWidth = A4_PORTRAIT.width - MARGIN * 2
  const maxHeight = A4_PORTRAIT.height - MARGIN * 2
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)

  const width = image.width * scale
  const height = image.height * scale
  page.drawImage(image, {
    x: (A4_PORTRAIT.width - width) / 2,
    y: (A4_PORTRAIT.height - height) / 2,
    width,
    height,
  })
}

/** Every page of a filed PDF that has anything on it, copied in as it stands. */
async function addPdfPages(sheet: Sheet, data: Buffer): Promise<void> {
  // A scan produced by a photocopier is sometimes 'encrypted' with an empty
  // owner password, which stops nothing and would otherwise stop this.
  const source = await PDFDocument.load(data, { ignoreEncryption: true })

  const wanted = await contentfulPageIndices(data, source.getPageCount())
  const pages: PDFPage[] = await sheet.pdf.copyPages(source, wanted)

  for (const page of pages) sheet.pdf.addPage(page)
}

/**
 * The documents, one after another, and nothing between them.
 *
 * THERE IS NO SEPARATOR PAGE. There used to be one before each document - the
 * name, 'Document 3 of 9', the date it came in - and for a file of ten
 * documents that was ten extra sheets to turn past. What somebody reading the
 * file wants is the documents; the office already knows what it sent.
 *
 * A DOCUMENT THAT CANNOT BE MERGED IS LEFT OUT SILENTLY. That is a deliberate
 * choice and worth naming, because the obvious objection is right: the reader
 * cannot tell it was ever there. The answer is that it should no longer be
 * possible - a file that cannot be opened is now refused at upload rather than
 * stored (see fileValidation.service.ts), so a document reaching this point
 * broken means something went wrong AFTER it was accepted, and a page of
 * apology inside somebody's file is not where that belongs. It is logged.
 */
export async function appendDocuments(
  sheet: Sheet,
  entries: readonly DocumentEntry[],
): Promise<void> {
  for (const entry of entries) {
    const supported =
      entry.file.mimeType === 'application/pdf' || entry.file.mimeType.startsWith('image/')

    if (!supported) {
      logger.warn(
        { documentName: entry.documentName, mimeType: entry.file.mimeType },
        'A document of an unmergeable type was left out of the employee file',
      )
      continue
    }

    try {
      // Read here, one document at a time, so the largest file in memory is the
      // largest single document rather than the sum of them.
      const data = await entry.file.read()

      if (entry.file.mimeType === 'application/pdf') await addPdfPages(sheet, data)
      else await addImagePage(sheet, data)
    } catch (error) {
      // One unreadable file does not lose the other nine.
      logger.warn(
        { err: error, documentName: entry.documentName },
        'A document could not be added to the employee file and was left out',
      )
    }
  }
}

/**
 * The footer, on the pages this file made and on no others.
 *
 * A document in the file is the document as it was filed - stamping a page
 * number across somebody's scanned card would change what the office is
 * holding out as a copy of it.
 */
export function drawOwnFooters(sheet: Sheet, ownPages: ReadonlySet<number>, meta: PrintMeta): void {
  const pages = sheet.pdf.getPages()
  const right = sheet.margin + sheet.contentWidth

  pages.forEach((page, index) => {
    if (!ownPages.has(index)) return

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
