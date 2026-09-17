import { createCanvas } from '@napi-rs/canvas'

/**
 * Turning a PDF page into pixels, and opening a PDF safely.
 *
 * Pulled out of the OCR service so that it and the box-occupancy check draw
 * the same page the same way, at the same scale, through one piece of code.
 * Two renderers that disagreed by a pixel would be two measurements that
 * disagreed by a threshold.
 */

/**
 * Rendering scale. 2x a 72dpi page is ~144dpi, which Tesseract reads well.
 *
 * 3.5x (~252dpi) was tried, on the theory that 144dpi is half what Tesseract
 * asks for. Measured on the company's PF form it read exactly the same three
 * fields as 2x and took 35 seconds instead of 26 - and that time is spent
 * inside the upload request, five pages of it against a 90 second budget. Left
 * where it is until a document turns up that a higher one demonstrably rescues.
 */
export const PAGE_RENDER_SCALE = 2

export type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
export type PdfDocument = import('pdfjs-dist/types/src/display/api.js').PDFDocumentProxy
export type PdfPage = import('pdfjs-dist/types/src/display/api.js').PDFPageProxy

let pdfjs: PdfModule | null = null

/**
 * pdf.js, loaded on first use.
 *
 * The legacy build, because the modern one expects browser globals that Node
 * does not have. Imported lazily so that starting the API does not pay for a
 * library most requests never touch.
 */
export async function loadPdfjs(): Promise<PdfModule> {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs
}

/**
 * Opens a PDF for reading, with the two options every reader here uses.
 *
 * A document is data, not a program: nothing in a PDF gets to run. And a
 * missing font changes no measurement and no word, so the system's are not
 * looked for.
 */
export async function openPdf(buffer: Buffer): Promise<PdfDocument> {
  const { getDocument } = await loadPdfjs()
  return getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise
}

/**
 * One page as a PNG, at the standard scale, on a white ground.
 *
 * White behind the page: a transparent background renders as black once
 * flattened, and Tesseract reads black text on black as nothing at all - and
 * an ink measurement would call the whole page ink.
 */
export async function renderPage(page: PdfPage, scale: number = PAGE_RENDER_SCALE): Promise<Buffer> {
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  // pdf.js types its context against the DOM's CanvasRenderingContext2D, which
  // does not exist in Node. @napi-rs/canvas implements the same surface, so the
  // cast is the type system catching up with what is really being passed.
  await page.render({
    canvasContext: context as unknown as Parameters<typeof page.render>[0]['canvasContext'],
    viewport,
  }).promise

  return canvas.toBuffer('image/png')
}
