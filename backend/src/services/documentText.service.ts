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
  /**
   * How sure Tesseract was, 0 to 100. 0 when nothing was read.
   *
   * The BEST any pass achieved, not the average. A page is read several times
   * over - different layouts, different sizes - and the text is added together,
   * so a pass that read badly does not make the reading as a whole untrustworthy
   * when another read it clearly.
   *
   * A PDF's own text layer is 100: those are the characters the file contains,
   * not a guess at what a photograph shows.
   *
   * Used for one thing only - deciding whether the reading is good enough to
   * tell somebody their document looks like the wrong TYPE. On a photocopy OCR
   * scores low and is often wrong, and a false accusation is worse than saying
   * nothing.
   */
  confidence: number
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

/**
 * Rendering scale for OCR. 2x a 72dpi page is ~144dpi, which Tesseract reads well.
 *
 * 3.5x (~252dpi) was tried, on the theory that 144dpi is half what Tesseract
 * asks for. Measured on the company's PF form it read exactly the same three
 * fields as 2x and took 35 seconds instead of 26 - and that time is spent
 * inside the upload request, five pages of it against a 90 second budget. Left
 * where it is until a document turns up that a higher one demonstrably rescues.
 */
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
const ocrWorkers = new Map<string, import('tesseract.js').Worker>()
let ocrQueue: Promise<unknown> = Promise.resolve()

async function getOcrWorker(
  key: string,
  languages: string,
  layout: PageLayout,
): Promise<import('tesseract.js').Worker> {
  const existing = ocrWorkers.get(key)
  if (existing) return existing

  const { createWorker } = await import('tesseract.js')
  // English AND Hindi. The company's own appointment letter is printed in
  // Hindi, and with 'eng' alone Tesseract returns nothing usable from it - not
  // a bad reading, no reading, which the check then reports as a document that
  // mentions none of the employee's details.
  //
  // Configurable because it is a trade: each language is a model to load and a
  // file to vendor onto the offline server, and an office with no Hindi
  // paperwork should not pay for one.
  const worker = await createWorker(languages, 1, {
    // Unset in development, where tesseract.js fetches these from a CDN. On the
    // company server, which has no route to the internet, they must point at a
    // local copy or every OCR pass fails.
    ...(env.TESSERACT_LANG_PATH ? { langPath: env.TESSERACT_LANG_PATH } : {}),
    ...(env.TESSERACT_CORE_PATH ? { corePath: env.TESSERACT_CORE_PATH } : {}),
    ...(env.TESSERACT_CACHE_PATH ? { cachePath: env.TESSERACT_CACHE_PATH } : {}),
    logger: () => undefined,
  })

  // A page rendered or upscaled here carries no DPI of its own that Tesseract
  // can trust, and it scales its internal work off that figure. Told 300 it
  // reads small print that it otherwise skips: on the office's PAN card the
  // name line comes back only when this is set.
  await worker.setParameters({
    tessedit_pageseg_mode: layout as unknown as Parameters<typeof worker.setParameters>[0]['tessedit_pageseg_mode'],
    user_defined_dpi: '300',
  })

  ocrWorkers.set(key, worker)
  return worker
}

/** Shuts the workers down, so the process can exit rather than hanging on them. */
export async function closeOcrWorker(): Promise<void> {
  const workers = [...ocrWorkers.values()]
  ocrWorkers.clear()
  await Promise.all(workers.map((worker) => worker.terminate()))
}

/**
 * How Tesseract is told to carve the page up.
 *
 * AUTO is its own layout analysis and is right for a form that fills the page.
 * SINGLE_BLOCK treats the whole image as one block of text, which is what reads
 * a small card photographed in the middle of a large empty page: the layout
 * analysis looks at all that white, decides there is no column structure worth
 * the name, and returns nothing at all for the card. Measured on the office's
 * PAN card, AUTO finds no trace of the name and SINGLE_BLOCK finds the line it
 * is printed on.
 *
 * A page is read with EACH of these and the text added together, because which
 * one wins depends on the document and there is no way to tell in advance.
 */
const PAGE_LAYOUTS = ['3', '6'] as const
type PageLayout = (typeof PAGE_LAYOUTS)[number]

/**
 * Roughly what one reading pass over a photograph costs.
 *
 * Measured: a SINGLE_BLOCK pass over a 2000px image is about twenty seconds.
 * Used only to decide whether there is time to start another one.
 */
const PASS_BUDGET_MS = 25_000

interface Recognised {
  text: string
  /** Tesseract's own score for the page, 0 to 100. */
  confidence: number
}

async function recognise(
  image: Buffer,
  languages: string,
  layout: PageLayout,
): Promise<Recognised> {
  const run = ocrQueue.then(async () => {
    // Keyed by layout as well as language, so a worker is configured once and
    // never re-configured underneath a call that is already using it.
    const worker = await getOcrWorker(`${languages}|${layout}`, languages, layout)
    const result = await worker.recognize(image)
    return { text: result.data.text, confidence: result.data.confidence }
  })

  // The queue must keep going even when one recognition fails, or a single bad
  // image would block every check after it for the life of the process.
  ocrQueue = run.catch(() => undefined)
  return run
}

/**
 * The scan inside a scanned PDF, at the resolution it was scanned.
 *
 * A "scanned PDF" is a photograph in a PDF wrapper: one image, placed on a page
 * of some nominal size, with no text of its own. Rendering that page throws
 * resolution away twice over - the image is resampled down onto an A4 canvas,
 * and the card that filled the photograph becomes a portion of a mostly empty
 * page. Measured on the office's PAN card, rendered at 72, 150, 200 and 300 dpi,
 * the employee's name could not be read at ANY of them, and upscaling afterwards
 * did not bring it back. The embedded image is 2518x1579 and reads.
 *
 * So the image is taken out and read directly. Only when the page is ONE image
 * and carries no real text: a page with several images, or with vector text
 * around them, is a laid-out document where the arrangement is part of the
 * meaning, and that is what rendering is for.
 *
 * Returns null whenever it is not that simple, and the caller renders instead.
 */
async function embeddedScan(
  page: import('pdfjs-dist/types/src/display/api.js').PDFPageProxy,
): Promise<Buffer | null> {
  try {
    const { OPS } = await loadPdfjs()
    const operators = await page.getOperatorList()

    const names: string[] = []
    for (let i = 0; i < operators.fnArray.length; i += 1) {
      const op = operators.fnArray[i]
      if (op === OPS.paintImageXObject || op === OPS.paintXObject) {
        const args = operators.argsArray[i] as unknown[]
        if (typeof args[0] === 'string') names.push(args[0])
      }
    }

    // One image, or this is a laid-out page rather than a scan.
    if (names.length !== 1) return null
    const only = names[0]
    if (only === undefined) return null

    // pdf.js resolves image objects lazily; the callback form waits for one.
    const image = await new Promise<{
      width: number
      height: number
      kind: number
      data: Uint8Array | Uint8ClampedArray
    } | null>((resolve) => {
      try {
        page.objs.get(only, (value: unknown) => resolve((value as never) ?? null))
      } catch {
        resolve(null)
      }
    })

    if (!image?.data || !image.width || !image.height) return null

    // Smaller than this is a logo or a signature strip, not a scanned page.
    if (Math.max(image.width, image.height) < 800) return null

    // pdf.js image kinds: 1 grayscale, 2 RGB, 3 RGBA.
    const channels = image.kind === 3 ? 4 : image.kind === 1 ? 1 : 3
    if (image.data.length < image.width * image.height * channels) return null

    return await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length), {
      raw: { width: image.width, height: image.height, channels },
    })
      .png()
      .toBuffer()
  } catch (error) {
    logger.warn({ err: error }, 'Could not take the image out of the PDF; rendering the page instead')
    return null
  }
}

/**
 * Whether this is a picture rather than a PDF.
 *
 * Listed rather than inferred from the 'image/' prefix: what belongs here is
 * what sharp can actually decode, and the upload validator accepts exactly this
 * set. A type that reached OCR without sharp being able to open it would come
 * back as an unreadable document, which is a confusing way to say
 * 'unsupported'.
 */
function isImageType(mimeType: string): boolean {
  return (
    mimeType === 'image/png' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/webp' ||
    mimeType === 'image/tiff'
  )
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

async function readPdf(
  buffer: Buffer,
  languages: string,
  layout: PageLayout,
  scale: number | undefined,
  isEnough?: (text: string) => boolean,
): Promise<ExtractedText> {
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
      // 100: these are the characters the file says it contains, not a reading
      // of a photograph. There is nothing here to be unsure about.
      return { text, source: TEXT_SOURCES.PDF_TEXT, pagesRead: pageCount, confidence: 100 }
    }

    // No usable text layer: this is a scan wearing a PDF wrapper, so render the
    // pages and read them the way a person would.
    //
    // Rendered pages go to OCR exactly as pdf.js drew them. Putting them
    // through the photograph preparation as well was tried and measured on the
    // company's own PF form, and it is actively harmful: reading it raw found
    // the name, the employee code and the joining date; the same page
    // greyscaled, contrast-normalised and sharpened found only the name. That
    // preparation exists to rescue an unevenly lit phone photo, and a page
    // rendered from a PDF is already flat, clean and correctly exposed - the
    // normalise step just crushes the faint entries it was meant to lift.
    const recognised: string[] = []
    let confidence = 0
    let read = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      // The scan itself where there is one, the rendered page otherwise.
      const scan = await embeddedScan(page)
      const image = scan ?? (await renderPage(page))
      // Scale variants only mean something on a real photograph; a rendered
      // page is already drawn at a chosen size.
      const result = scan
        ? await recognise(await prepareForOcr(scan, scale), languages, layout)
        : await recognise(image, languages, layout)

      recognised.push(result.text)
      confidence = Math.max(confidence, result.confidence)
      read = pageNumber

      // Stop as soon as the caller has what it came for. A form carries its
      // details on the first page and the rest is terms and a nominee table;
      // reading those cost seconds each to confirm something already confirmed,
      // inside a request somebody is sitting and waiting on.
      if (isEnough?.(recognised.join('\n'))) break
    }

    const ocrText = recognised.join('\n')
    return {
      text: ocrText,
      source: ocrText.trim().length > 0 ? TEXT_SOURCES.OCR : TEXT_SOURCES.NONE,
      pagesRead: read,
      confidence,
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
 * A ceiling in PIXELS rather than width, for the scaled passes below.
 *
 * MAX_OCR_WIDTH used to clamp everything, and that quietly cancelled the whole
 * point of trying 3x: three times a 2518px scan is 7554px, which was clipped
 * straight back to 4000 and read at the wrong size. This is here only so that a
 * 50 MP photograph tripled does not become a bitmap nothing can hold.
 */
const MAX_OCR_PIXELS = 40_000_000

/**
 * The scales a photograph is read at, as MULTIPLES of its own size.
 *
 * Multiples, not fixed widths, because that is what actually varies: what
 * matters to Tesseract is how many pixels a printed character ends up with, and
 * that follows the image's own resolution. Fixed widths also hid the 3x case
 * entirely - it was clamped to the 4000px ceiling and never tried.
 *
 * No single scale works on these documents. Measured on the office's own files:
 *
 *   PAN card             found the name ONLY at 3x. 1x, 2x and 4x all failed.
 *   Payment of Gratuity  found it at 1x and 2x. Failed at 3x.
 *   Service card         found it at every scale.
 *
 * Fixing the scale for one breaks the other, so the page is read at several and
 * the text added together. Reading STOPS the moment the name is found, so a
 * document that reads at 1x never pays for the rest.
 *
 * Deliberately no auto-cropping to the card: it was tried on the embedded image
 * and stopped the name being found at all.
 */
const OCR_SCALES = [1, 2, 3] as const

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
async function prepareForOcr(buffer: Buffer, scale?: number): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata()
    const width = metadata.width ?? 0

    let pipeline = sharp(buffer, { failOn: 'none' }).rotate()

    if (scale === 1) {
      // Left at the size it arrived. Not a no-op worth skipping: enlarging a
      // small card can smear the very strokes that distinguish B from H, and on
      // the office's gratuity form the untouched image is the one that reads.
    } else if (scale !== undefined && width > 0) {
      const height = metadata.height ?? 0
      // Capped on total pixels, not width, so a large scan tripled is refused
      // for being enormous rather than quietly read at the wrong size.
      const wanted = height > 0 && width * scale * (height * scale) > MAX_OCR_PIXELS
        ? Math.floor(width * Math.sqrt(MAX_OCR_PIXELS / (width * height)))
        : Math.round(width * scale)
      pipeline = pipeline.resize({ width: wanted })
    } else if (width > 0 && width < MIN_OCR_WIDTH) {
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

/**
 * The shortest side a photocopy is worth reading at.
 *
 * Every identity card at this company arrives as a low-contrast JPG photocopy,
 * often small. The existing rule only ever looks at WIDTH, so a card that is
 * wide and short - which is the shape of a PAN card - is left at whatever size
 * it came in at, and Tesseract has too few pixels per character to work with.
 */
const MIN_PHOTOCOPY_SIDE = 1500

/**
 * Prepares a low-contrast photocopy, which is what this office actually files.
 *
 * DIFFERENT FROM prepareForOcr, and deliberately a second thing rather than a
 * change to the first. That one is tuned on the documents that already read,
 * and the notes in this file record what happened when its steps were applied
 * more widely: the company's PF form read WORSE, not better. So this is an
 * extra pass with its own preparation, and its text is added to what the
 * ordinary passes found rather than replacing it. Nothing that works today can
 * be broken by it.
 *
 * The one real difference is `clahe`. `normalise` stretches the contrast of the
 * WHOLE image at once, so a photocopy that is dark down one side stays dark
 * down one side - the bright half uses up the range. clahe works tile by tile,
 * lifting each small area on its own, which is exactly the shape of the problem
 * on a page copied off a machine with a failing lamp.
 *
 * The shorter side is brought up to 1500px because Tesseract needs pixels per
 * character, not pixels per page.
 */
async function prepareForPhotocopy(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0

    let pipeline = sharp(buffer, { failOn: 'none' }).rotate()

    const shortest = Math.min(width, height)
    if (shortest > 0 && shortest < MIN_PHOTOCOPY_SIDE) {
      const factor = MIN_PHOTOCOPY_SIDE / shortest
      const capped = width * factor * (height * factor) > MAX_OCR_PIXELS
        ? Math.sqrt(MAX_OCR_PIXELS / (width * height))
        : factor
      pipeline = pipeline.resize({ width: Math.round(width * capped) })
    }

    return await pipeline
      .greyscale()
      // Tile by tile rather than the whole page at once - see above.
      .clahe({ width: 8, height: 8 })
      .sharpen()
      .png()
      .toBuffer()
  } catch (error) {
    logger.warn({ err: error }, 'Could not prepare the photocopy for OCR; reading it as it arrived')
    return buffer
  }
}

/**
 * Reads a photograph.
 *
 * Rotation detection was built here and then taken out again, which is worth
 * recording so it is not built a second time. It worked, in the sense that
 * mattered least: given the office's PF form turned on its side it correctly
 * identified 90 degrees, by scoring how much of each trial reading fell inside
 * real words. What it could not do was recover the page - reading it back the
 * right way up still found neither the name nor the employee code, because a
 * photograph that OCR cannot follow across lines is usually also blurred,
 * skewed or lit unevenly, and turning it does not fix any of that.
 *
 * It cost 82 seconds against a 90 second budget, up from 31. So the honest
 * trade was: no documents rescued, and every hard-to-read one pushed to the
 * edge of a timeout. A sideways page is refused, and the person holding it
 * accepts it with a reason - which takes them a sentence, not a minute and a
 * half of waiting for the same refusal.
 */
async function readImage(
  buffer: Buffer,
  languages: string,
  layout: PageLayout,
  scale?: number,
  photocopy = false,
): Promise<ExtractedText> {
  const prepared = photocopy
    ? await prepareForPhotocopy(buffer)
    : await prepareForOcr(buffer, scale)
  const { text, confidence } = await recognise(prepared, languages, layout)

  return {
    text,
    source: text.trim().length > 0 ? TEXT_SOURCES.OCR : TEXT_SOURCES.NONE,
    pagesRead: 1,
    confidence,
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
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  /**
   * Whether the text so far already answers the caller's question.
   *
   * Optional, and only ever used to stop work early - never to change what is
   * returned. Reading is otherwise the same whether anyone asks or not.
   */
  isEnough?: (text: string) => boolean,
  /**
   * Read in these languages only, whatever the environment says.
   *
   * Used for the identity cards. They are printed in English, and reading them
   * with the Hindi model as well produces hundreds of false diacritics over
   * English letters - a name that would have matched comes back decorated and
   * does not. See checkUpload.
   */
  languageOverride?: string,
): Promise<ExtractedText> {
  const unread: ExtractedText = {
    text: '',
    source: TEXT_SOURCES.NONE,
    pagesRead: 0,
    confidence: 0,
  }

  const startedAt = Date.now()

  // Held out here so that a timeout can hand back what HAS been read. Reading
  // now happens in several passes, and returning nothing because the last one
  // ran long would throw away a name the first one found.
  let combined = ''
  let best: ExtractedText = unread
  let bestConfidence = 0

  const soFarAsResult = (): ExtractedText => ({
    text: combined,
    source: combined.trim().length > 0 ? TEXT_SOURCES.OCR : TEXT_SOURCES.NONE,
    pagesRead: best.pagesRead,
    confidence: bestConfidence,
  })

  const readWith = async (
    languages: string,
    layout: PageLayout,
    scale: number | undefined,
    enoughSoFar?: (text: string) => boolean,
    photocopy = false,
  ): Promise<ExtractedText> => {
    if (mimeType === 'application/pdf') return readPdf(buffer, languages, layout, scale, enoughSoFar)
    if (isImageType(mimeType)) return readImage(buffer, languages, layout, scale, photocopy)
    return unread
  }

  /**
   * English first, and the other languages only if English did not answer it.
   *
   * Measured on the office's PF form: 'eng' reads it in 7 seconds and
   * 'eng+hin' in 15, finding exactly the same name, code and joining date. Two
   * language models is twice the work on every page, and nine of the ten
   * document types are printed in English - they were all paying for the Hindi
   * appointment letter.
   *
   * The fallback is what keeps that honest. A page the fast pass could not make
   * sense of is read again with the full set, so the Hindi letter still reads;
   * it just costs the extra pass rather than charging it to everything else.
   */
  const read = async (): Promise<ExtractedText> => {
    const languageSets = languageOverride
      ? [languageOverride]
      : env.OCR_PRIMARY_LANGUAGES === env.OCR_LANGUAGES
        ? [env.OCR_LANGUAGES]
        : [env.OCR_PRIMARY_LANGUAGES, env.OCR_LANGUAGES]

    // Cheapest and most often right first, then wider. Each pass ADDS its text
    // to what came before rather than replacing it, because a pass that reads
    // the page badly overall may still be the only one that read the one line
    // being looked for - which is exactly the PAN card's case.
    //
    // NOT the full cross product. Every combination except one earns its place;
    // the extra languages read with SINGLE_BLOCK is the exception, and it is the
    // most expensive thing here by a distance. Measured on the office's PAN card:
    //
    //   eng     psm 3   1.3s     0 characters
    //   eng     psm 6  22.5s  2173 characters
    //   eng+hin psm 3   1.8s     0 characters
    //   eng+hin psm 6  44.7s  2116 characters   <- dropped
    //
    // Forty-five seconds to return slightly LESS than the pass before it, inside
    // a request somebody is waiting on, on the way to the same answer. Dropping
    // it takes the worst case from about seventy seconds to about twenty-six.
    //
    // The Hindi appointment letter is not affected: it reads on the very first
    // pass, and would still get a full-language reading with the normal layout.
    interface Pass {
      languages: string
      layout: PageLayout
      /** A multiple of the image's own size. undefined keeps the default rule. */
      scale: number | undefined
      /** Prepared for a low-contrast photocopy instead - see prepareForPhotocopy. */
      photocopy?: boolean
    }

    const isImage = isImageType(mimeType)
    const fast = languageSets[0] ?? env.OCR_LANGUAGES

    // A photograph is also read at SEVERAL SIZES, because no single one works.
    // Measured on the office's own files: the PAN card gives up the name only at
    // 3x, the gratuity form only at 1x and 2x, and the service card at any of
    // them. Fixing the size for one breaks the other, so all three are tried and
    // the text added together.
    //
    // The PDF route does not do this - its pages are rendered at a known scale
    // from vector geometry rather than resampled from a photograph, and no PDF
    // has yet needed a second size.
    const passes: Pass[] = isImage
      ? [
          // The order the office measured, cheapest first. SINGLE_BLOCK at the
          // image's own size reads most of these cards; 3x is what rescues the
          // PAN card and nothing else does.
          { languages: fast, layout: '6', scale: OCR_SCALES[0] },
          { languages: fast, layout: '3', scale: OCR_SCALES[0] },
          { languages: fast, layout: '6', scale: OCR_SCALES[1] },
          // The photocopy pass, placed after the ones that read the documents
          // this office could already read and before the expensive tail. Every
          // identity card here is a low-contrast JPG photocopy, so this is the
          // pass most likely to rescue one - but it goes second, never first,
          // because it must not be able to spend the budget of a document that
          // the ordinary preparation would have read.
          { languages: fast, layout: '6', scale: undefined, photocopy: true },
          { languages: fast, layout: '6', scale: OCR_SCALES[2] },
          { languages: fast, layout: '3', scale: OCR_SCALES[2] },
          ...languageSets.slice(1).map((languages) => ({
            languages,
            layout: '3' as PageLayout,
            scale: undefined,
          })),
        ]
      : languageSets.flatMap((languages, index) =>
          PAGE_LAYOUTS.filter((layout) => index === 0 || layout === PAGE_LAYOUTS[0]).map(
            (layout) => ({ languages, layout, scale: undefined }),
          ),
        )

    const settled = (text: string): boolean =>
      isEnough ? isEnough(text) : text.trim().length > 0

    for (const [index, pass] of passes.entries()) {
      // Do not START a pass that cannot finish. A single SINGLE_BLOCK reading of
      // a photograph takes around twenty seconds, and one begun with less than
      // that left is twenty seconds spent to be cut off mid-way - the budget
      // gone and nothing added. Better to stop with what has been read.
      const remaining = env.IDENTITY_CHECK_TIMEOUT_MS - (Date.now() - startedAt)
      if (index > 0 && remaining < PASS_BUDGET_MS) {
        logger.info(
          { remaining, pass: index + 1 },
          'Not enough time left for another reading pass; using what was read',
        )
        break
      }

      const out = await readWith(
        pass.languages,
        pass.layout,
        pass.scale,
        (soFar) => settled(combined ? `${combined}\n${soFar}` : soFar),
        pass.photocopy ?? false,
      )

      // A PDF that carries its own text layer is answered exactly, once. There
      // is no second reading to add and no layout to guess at - these are the
      // characters the file contains.
      if (out.source === TEXT_SOURCES.PDF_TEXT) return out

      combined = combined ? `${combined}\n${out.text}` : out.text
      if (out.text.trim().length > 0) best = out
      // The best any pass managed, not the last one's - see ExtractedText.
      if (out.text.trim().length > 0) bestConfidence = Math.max(bestConfidence, out.confidence)

      if (settled(combined)) {
        if (index > 0) {
          logger.info(
            {
              languages: pass.languages,
              layout: pass.layout,
              scale: pass.scale,
              pass: index + 1,
            },
            'An extra reading pass was what settled this document',
          )
        }
        break
      }
    }

    return soFarAsResult()
  }

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ExtractedText>((resolve) => {
    timer = setTimeout(() => {
      // Whatever has been read by now, not nothing. A document that ran over
      // the budget on its third reading pass has usually already been read once
      // successfully, and discarding that told the person their document could
      // not be read when it had been.
      logger.warn(
        { mimeType, chars: combined.length },
        'Document text extraction timed out; using what was read by then',
      )
      resolve(soFarAsResult())
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
