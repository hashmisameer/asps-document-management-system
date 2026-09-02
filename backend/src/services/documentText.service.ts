import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'
import { TEXT_SOURCES, type TextSource } from '@asps-dms/shared'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * Reading the words out of an uploaded document.
 *
 * Two routes, and which one is used matters enough to be reported alongside the
 * answer:
 *
 *   1. A PDF's own TEXT LAYER. Exact - these are the characters the file
 *      contains, not a reading of a picture of them. Every PDF produced by
 *      Word, a printer driver or a payroll system has one.
 *
 *   2. OCR over the rendered pages, for a scan or a photograph, where there is
 *      no text layer to read. Good, and not exact: a digit can come back wrong,
 *      which is precisely why a failed check can be overridden by a person
 *      rather than being the end of the matter.
 *
 * Nothing here decides anything. It returns text; documentVerification.service
 * decides what that text means.
 */

export interface ExtractedText {
  text: string
  source: TextSource
  pagesRead: number
}

/**
 * Below this, a PDF's text layer is treated as absent rather than as an answer.
 *
 * A scanned PDF is not empty of text: it usually carries a scanner watermark, a
 * page number, or a few characters of junk. Accepting that as the document's
 * text would mean checking a service card against the word 'Scanned', finding
 * nothing, and refusing a document that OCR would have read perfectly.
 */
const MIN_USEFUL_TEXT_LENGTH = 60

/** Rendering scale for OCR. 2x a 72dpi page is ~144dpi, which Tesseract reads well. */
const OCR_RENDER_SCALE = 2

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjs: PdfModule | null = null

/**
 * pdf.js, loaded on first use.
 *
 * The legacy build, because the modern one expects browser globals that Node
 * does not have. Imported lazily so that starting the API does not pay for a
 * library most requests never touch.
 */
async function loadPdfjs(): Promise<PdfModule> {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs
}

/**
 * The OCR worker.
 *
 * One worker for the whole process, created on first use and kept: starting one
 * loads the language model, which costs seconds, and paying that per upload
 * would make every scan upload feel broken.
 *
 * Calls are serialised through `ocrQueue` because a worker recognises one image
 * at a time; two overlapping calls would interleave and return each other's
 * text, which here means checking one employee's document against another's.
 */
let ocrWorker: import('tesseract.js').Worker | null = null
let ocrQueue: Promise<unknown> = Promise.resolve()

async function getOcrWorker(): Promise<import('tesseract.js').Worker> {
  if (ocrWorker) return ocrWorker

  const { createWorker } = await import('tesseract.js')
  // English AND Hindi. The company's own appointment letter is printed in
  // Hindi, and with 'eng' alone Tesseract returns nothing usable from it - not
  // a bad reading, no reading, which the check then reports as a document that
  // mentions none of the employee's details.
  //
  // Configurable because it is a trade: each language is a model to load and a
  // file to vendor onto the offline server, and an office with no Hindi
  // paperwork should not pay for one.
  ocrWorker = await createWorker(env.OCR_LANGUAGES, 1, {
    // Unset in development, where tesseract.js fetches these from a CDN. On the
    // company server, which has no route to the internet, they must point at a
    // local copy or every OCR pass fails.
    ...(env.TESSERACT_LANG_PATH ? { langPath: env.TESSERACT_LANG_PATH } : {}),
    ...(env.TESSERACT_CORE_PATH ? { corePath: env.TESSERACT_CORE_PATH } : {}),
    ...(env.TESSERACT_CACHE_PATH ? { cachePath: env.TESSERACT_CACHE_PATH } : {}),
    logger: () => undefined,
  })
  return ocrWorker
}

/** Shuts the worker down, so the process can exit rather than hanging on it. */
export async function closeOcrWorker(): Promise<void> {
  const worker = ocrWorker
  ocrWorker = null
  if (worker) await worker.terminate()
}

async function recognise(image: Buffer): Promise<string> {
  const run = ocrQueue.then(async () => {
    const worker = await getOcrWorker()
    const result = await worker.recognize(image)
    return result.data.text
  })

  // The queue must keep going even when one recognition fails, or a single bad
  // image would block every check after it for the life of the process.
  ocrQueue = run.catch(() => undefined)
  return run
}

/** Renders one page to a PNG for OCR. */
async function renderPage(
  page: import('pdfjs-dist/types/src/display/api.js').PDFPageProxy,
): Promise<Buffer> {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')

  // White behind the page: a transparent background renders as black once
  // flattened, and Tesseract reads black text on black as nothing at all.
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

async function readPdf(buffer: Buffer): Promise<ExtractedText> {
  const { getDocument } = await loadPdfjs()

  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    // A document is data, not a program: nothing in a PDF gets to run here.
    isEvalSupported: false,
    // The check reads words, and a missing font changes none of them.
    useSystemFonts: false,
  }).promise

  try {
    const pageCount = Math.min(pdf.numPages, env.IDENTITY_CHECK_MAX_PAGES)
    const layers: string[] = []

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      layers.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' '),
      )
    }

    const text = layers.join('\n')
    if (text.replace(/\s/g, '').length >= MIN_USEFUL_TEXT_LENGTH) {
      return { text, source: TEXT_SOURCES.PDF_TEXT, pagesRead: pageCount }
    }

    // No usable text layer: this is a scan wearing a PDF wrapper, so render the
    // pages and read them the way a person would.
    const recognised: string[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      recognised.push(await recognise(await renderPage(page)))
    }

    const ocrText = recognised.join('\n')
    return {
      text: ocrText,
      source: ocrText.trim().length > 0 ? TEXT_SOURCES.OCR : TEXT_SOURCES.NONE,
      pagesRead: pageCount,
    }
  } finally {
    await pdf.destroy()
  }
}

/**
 * The smallest width worth handing to OCR.
 *
 * Tesseract wants roughly 300 DPI. A photograph taken on a phone and sent
 * through a messaging app arrives recompressed and downscaled, and at that size
 * the digits in a date are a few pixels tall - readable to a person, not to OCR.
 */
const MIN_OCR_WIDTH = 2000

/** A ceiling, so a 50 MP photograph does not become an enormous bitmap. */
const MAX_OCR_WIDTH = 4000

/**
 * Prepares a photograph for OCR.
 *
 * An uploaded image used to go straight to Tesseract exactly as it arrived.
 * That is fine for a flat-bed scan and poor for what people actually send: a
 * photo of a form on a desk, lit unevenly and squeezed by WhatsApp.
 *
 * Rotated to its EXIF orientation, upscaled if small, greyscaled,
 * contrast-normalised and sharpened - the things that most affect whether
 * printed digits come back as digits. The output is PNG so the work is not
 * undone by a second round of JPEG artefacts.
 *
 * If any of it fails the original buffer is used: preparation that cannot run
 * must not turn a readable document into an unreadable one.
 */
async function prepareForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata()
    const width = metadata.width ?? 0

    let pipeline = sharp(buffer, { failOn: 'none' }).rotate()
    if (width > 0 && width < MIN_OCR_WIDTH) {
      pipeline = pipeline.resize({ width: Math.min(MIN_OCR_WIDTH, MAX_OCR_WIDTH) })
    } else if (width > MAX_OCR_WIDTH) {
      pipeline = pipeline.resize({ width: MAX_OCR_WIDTH })
    }

    return await pipeline.greyscale().normalise().sharpen().png().toBuffer()
  } catch (error) {
    logger.warn({ err: error }, 'Could not prepare the image for OCR; reading it as it arrived')
    return buffer
  }
}

async function readImage(buffer: Buffer): Promise<ExtractedText> {
  const text = await recognise(await prepareForOcr(buffer))
  return {
    text,
    source: text.trim().length > 0 ? TEXT_SOURCES.OCR : TEXT_SOURCES.NONE,
    pagesRead: 1,
  }
}

/**
 * Reads a document, within a time limit.
 *
 * The limit matters because this runs inside the upload request: OCR over a
 * multi-page scan can take a while, and a request that never answers looks to
 * whoever is uploading like the system has hung. A timeout returns no text,
 * which the verification service reports as 'could not be read' - a refusal a
 * person can act on, rather than a hang they cannot.
 */
export async function extractText(buffer: Buffer, mimeType: string): Promise<ExtractedText> {
  const unread: ExtractedText = { text: '', source: TEXT_SOURCES.NONE, pagesRead: 0 }

  const read = async (): Promise<ExtractedText> => {
    if (mimeType === 'application/pdf') return readPdf(buffer)
    if (mimeType === 'image/png' || mimeType === 'image/jpeg') return readImage(buffer)
    return unread
  }

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ExtractedText>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ mimeType }, 'Document text extraction timed out')
      resolve(unread)
    }, env.IDENTITY_CHECK_TIMEOUT_MS)
  })

  try {
    return await Promise.race([read(), timeout])
  } catch (error) {
    // A document that cannot be parsed is not an error worth a 500: it is a
    // document that could not be read, which is an answer the check handles.
    logger.warn({ err: error, mimeType }, 'Could not read the text of a document')
    return unread
  } finally {
    if (timer) clearTimeout(timer)
  }
}
