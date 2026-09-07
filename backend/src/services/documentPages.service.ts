import { PDFDocument, type PDFPage } from 'pdf-lib'
import sharp from 'sharp'
import { logger } from '../utils/logger.js'
import {
  A4_PORTRAIT,
  MUTED,
  RULE,
  draw,
  drawRight,
  formatDate,
  formatTimestamp,
  newPage,
  rule,
  wrap,
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
 * THE DOCUMENTS THEMSELVES ARE REPRODUCED UNTOUCHED. No page number, no footer,
 * nothing stamped across somebody's scanned Aadhaar card: a document that comes
 * out of here is the document as it was filed. Everything added around them -
 * the separators, the page saying one could not be read - is on pages of its
 * own, and drawOwnFooters is careful to sign only those.
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

/**
 * The page before each document.
 *
 * Its whole job is to answer 'where does this one start' when somebody is
 * scrolling or has printed the lot, so the name is set large and everything
 * else sits under it.
 */
function drawSeparator(
  sheet: Sheet,
  entry: DocumentEntry,
  position: { index: number; total: number },
  problem?: string,
): void {
  newPage(sheet)
  const top = sheet.y

  draw(sheet.page, `Document ${position.index} of ${position.total}`, {
    x: sheet.margin,
    y: top - 12,
    font: sheet.fonts.regular,
    size: 9,
    color: MUTED,
  })

  const lines = wrap(entry.documentName, sheet.fonts.bold, 22, sheet.contentWidth)
  lines.forEach((line, index) => {
    draw(sheet.page, line, {
      x: sheet.margin,
      y: top - 42 - index * 26,
      font: sheet.fonts.bold,
      size: 22,
    })
  })

  sheet.y = top - 42 - lines.length * 26
  rule(sheet, 12, 14)

  const facts: string[] = [
    entry.uploadedAt ? `Received ${formatDate(entry.uploadedAt)}` : 'Received',
    entry.uploadedByName ? `Uploaded by ${entry.uploadedByName}` : '',
    // Which copy this is. A signed document and the original it was made from
    // are different pieces of paper, and somebody reading the file is entitled
    // to know which one they are looking at.
    entry.file.isSigned ? 'Signed copy' : 'As it was uploaded',
  ].filter(Boolean)

  for (const fact of facts) {
    draw(sheet.page, fact, { x: sheet.margin, y: sheet.y, font: sheet.fonts.regular, size: 10 })
    sheet.y -= 15
  }

  if (problem) {
    sheet.y -= 10
    for (const line of wrap(problem, sheet.fonts.bold, 10, sheet.contentWidth)) {
      draw(sheet.page, line, { x: sheet.margin, y: sheet.y, font: sheet.fonts.bold, size: 10 })
      sheet.y -= 14
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The documents themselves                                                    */
/* -------------------------------------------------------------------------- */

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

/** Every page of a filed PDF, copied in as it stands. */
async function addPdfPages(sheet: Sheet, data: Buffer): Promise<void> {
  // A scan produced by a photocopier is sometimes 'encrypted' with an empty
  // owner password, which stops nothing and would otherwise stop this.
  const source = await PDFDocument.load(data, { ignoreEncryption: true })
  const pages: PDFPage[] = await sheet.pdf.copyPages(source, source.getPageIndices())

  for (const page of pages) sheet.pdf.addPage(page)
}

/**
 * Each document, behind a page saying what it is.
 *
 * Page indices this adds are collected into `ownPages` - see drawOwnFooters for
 * why that distinction is worth keeping.
 */
export async function appendDocuments(
  sheet: Sheet,
  entries: readonly DocumentEntry[],
  ownPages: Set<number>,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    const unsupported = !(
      entry.file.mimeType === 'application/pdf' || entry.file.mimeType.startsWith('image/')
    )

    drawSeparator(
      sheet,
      entry,
      { index: index + 1, total: entries.length },
      unsupported
        ? `This document is a ${entry.file.mimeType} file and could not be included. Download it on its own.`
        : undefined,
    )
    ownPages.add(sheet.pdf.getPageCount() - 1)

    if (unsupported) continue

    try {
      // Read here, one document at a time, so the largest file in memory is the
      // largest single document rather than the sum of them.
      const data = await entry.file.read()

      if (entry.file.mimeType === 'application/pdf') await addPdfPages(sheet, data)
      else await addImagePage(sheet, data)
    } catch (error) {
      // One unreadable file does not lose the other nine. The separator has
      // already been written, so the file still accounts for every document;
      // this only adds why its pages are not behind it.
      logger.warn(
        { err: error, documentName: entry.documentName },
        'A document could not be added to the employee file',
      )
      const page = sheet.pdf.addPage([A4_PORTRAIT.width, A4_PORTRAIT.height])
      ownPages.add(sheet.pdf.getPageCount() - 1)
      draw(page, 'This document could not be read, and is not in this file.', {
        x: MARGIN,
        y: A4_PORTRAIT.height - MARGIN - 20,
        font: sheet.fonts.bold,
        size: 11,
      })
      draw(page, 'Download it on its own to see what is wrong with it.', {
        x: MARGIN,
        y: A4_PORTRAIT.height - MARGIN - 38,
        font: sheet.fonts.regular,
        size: 10,
        color: MUTED,
      })
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
