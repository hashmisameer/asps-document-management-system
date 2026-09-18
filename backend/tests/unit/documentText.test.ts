import { describe, expect, it, afterAll } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { matchWords } from '@asps-dms/shared'
import { closeOcrWorker, extractText } from '../../src/services/documentText.service.js'

/**
 * Reading a PAN card, in the three shapes the office actually sends one.
 *
 * The cards are DRAWN here rather than committed as files. A real Aadhaar or PAN
 * card is a photograph of somebody's identity document; putting one in the
 * repository would spread it to every clone and every backup for ever, and the
 * secret scanner exists precisely to stop identity numbers being committed. What
 * these fixtures need to exercise is the three code paths - a photograph, a
 * smaller photograph, and a scan wrapped in a PDF - and a drawn card does that
 * exactly as well.
 *
 * The PAN below is the documented placeholder, not anyone's.
 */

const NAME = 'BHAGWAN SINGH'
// asps-dms:allow-secret - the documented placeholder PAN, not anyone's.
const FIXTURE_PAN = 'ABCDE1234F'

/** A PAN card, drawn at whatever size is asked for. */
function drawCard(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const unit = width / 1000

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#111111'

  ctx.font = `bold ${Math.round(34 * unit)}px Arial`
  ctx.fillText('INCOME TAX DEPARTMENT', 30 * unit, 70 * unit)
  ctx.font = `bold ${Math.round(40 * unit)}px Arial`
  ctx.fillText(FIXTURE_PAN, 320 * unit, 210 * unit)
  ctx.font = `${Math.round(20 * unit)}px Arial`
  ctx.fillText('Name', 150 * unit, 290 * unit)
  ctx.font = `bold ${Math.round(30 * unit)}px Arial`
  ctx.fillText(NAME, 150 * unit, 330 * unit)

  return canvas.toBuffer('image/png')
}

/** The card as a scan inside a PDF: one image on an A4 page, no text of its own. */
async function asScannedPdf(image: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const embedded = await pdf.embedPng(image)

  // Placed small on a large page, which is what makes rendering the page lose
  // the resolution the scan actually has.
  const width = 400
  const height = (embedded.height / embedded.width) * width
  page.drawImage(embedded, { x: 90, y: 500, width, height })

  return Buffer.from(await pdf.save())
}

afterAll(async () => {
  await closeOcrWorker()
})

describe('a PAN card, in each shape the office sends one', () => {
  // OCR is slow, and these run it several times over.
  const timeout = 240_000

  it(
    'reads the name from the card as photographed',
    async () => {
      const original = await sharp(drawCard(1200, 760)).jpeg({ quality: 92 }).toBuffer()
      const out = await extractText(original, 'image/jpeg', (t) => matchWords(NAME, t))

      expect(matchWords(NAME, out.text)).toBe(true)
    },
    timeout,
  )

  it(
    'reads the name from a smaller crop of the same card',
    async () => {
      // The shape the office reported: the card cut out of the page, 987x630.
      const cropped = await sharp(drawCard(987, 630)).jpeg({ quality: 92 }).toBuffer()
      const out = await extractText(cropped, 'image/jpeg', (t) => matchWords(NAME, t))

      expect(matchWords(NAME, out.text)).toBe(true)
    },
    timeout,
  )

  it(
    'reads the name from the scan inside a PDF, rather than from the rendered page',
    async () => {
      // The case that sent this down a long road: rendering this page at 72,
      // 150, 200 and 300 dpi found the name at none of them, because the scan is
      // resampled onto A4 and the card becomes a corner of a mostly empty sheet.
      // Taking the image out of the PDF and reading THAT works.
      const pdf = await asScannedPdf(drawCard(2518, 1579))
      const out = await extractText(pdf, 'application/pdf', (t) => matchWords(NAME, t))

      expect(matchWords(NAME, out.text)).toBe(true)
    },
    timeout,
  )
})

describe('the formats a card may be uploaded as', () => {
  const timeout = 240_000

  // WebP is what an Android phone and WhatsApp produce; TIFF is what an office
  // scanner writes. Both are accepted by the upload validator, so both have to
  // be readable here - accepting a file that then cannot be read is worse than
  // refusing it.
  it.each([
    ['webp', async (png: Buffer) => sharp(png).webp({ quality: 92 }).toBuffer(), 'image/webp'],
    ['tiff', async (png: Buffer) => sharp(png).tiff().toBuffer(), 'image/tiff'],
  ])(
    'reads a card sent as %s',
    async (_label, encode, mimeType) => {
      const card = await encode(drawCard(1200, 760))
      const out = await extractText(card, mimeType, (t) => matchWords(NAME, t))

      expect(matchWords(NAME, out.text)).toBe(true)
    },
    timeout,
  )
})

describe('an image that cannot be prepared', () => {
  const timeout = 60_000

  it(
    'is reported as unreadable when Tesseract could not read it as it arrived, rather than handed over',
    async () => {
      // A TIFF header and nothing after it: sharp cannot open it, and neither
      // can the Leptonica inside tesseract.js. The old fallback handed it
      // over anyway, and the rejected job became an uncaught exception.
      const stub = Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(64)])

      const out = await extractText(stub, 'image/tiff', (t) => matchWords(NAME, t))

      expect(out.text).toBe('')
      expect(out.source).toBe('None')
    },
    timeout,
  )

  it(
    'is still read as it arrived when it is a format Tesseract can decode',
    async () => {
      // A real JPEG whose preparation is made to fail is not made unreadable
      // by that: it goes to Tesseract as it is. Preparation cannot be made to
      // fail on a valid file from here, so this pins the other half - a JPEG
      // reads at all through the same path.
      const jpeg = await sharp(drawCard(1200, 760)).jpeg({ quality: 92 }).toBuffer()
      const out = await extractText(jpeg, 'image/jpeg', (t) => matchWords(NAME, t))

      expect(matchWords(NAME, out.text)).toBe(true)
    },
    timeout,
  )

  it(
    'leaves the process standing when Tesseract itself rejects the image',
    async () => {
      // A PNG signature over garbage: sharp refuses it, so it is handed to
      // Tesseract as it arrived - PNG is a format it reads - and Leptonica
      // rejects it. Without an errorHandler on the worker that rejection was
      // rethrown inside a message listener, which vitest reports as an
      // unhandled error and server.ts treats as fatal. The run passing at all
      // is the assertion for that.
      const garbage = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(256, 0x5a),
      ])

      const out = await extractText(garbage, 'image/png', (t) => matchWords(NAME, t))

      expect(out.text).toBe('')
      expect(out.source).toBe('None')
    },
    timeout,
  )
})
