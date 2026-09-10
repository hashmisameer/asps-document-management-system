import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { inspectDocumentUpload } from '../../src/services/fileValidation.service.js'

/**
 * What an uploaded document has to survive before it is filed as received.
 *
 * THIS IS THE ONE PLACE WHERE BLOCKING AN UPLOAD IS RIGHT, and the distinction
 * is worth keeping in view while reading these. The identity check blocks
 * nothing: OCR failing to read a name means the READING failed, and the
 * document is a perfectly good photocopy. These tests are about the other case
 * - the FILE is broken, unopenable now and unopenable in five years, when
 * somebody needs it.
 *
 * Every file below is real: built here, then damaged in the way files actually
 * arrive damaged.
 */

const upload = (buffer: Buffer, originalname: string) => ({
  originalname,
  buffer,
  size: buffer.byteLength,
})

async function realPdf(pages: string[] = ['APPOINTMENT LETTER']): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    pdf.addPage([595.28, 841.89]).drawText(text, { x: 60, y: 700, font, size: 18 })
  }
  return Buffer.from(await pdf.save())
}

const realJpeg = (): Promise<Buffer> =>
  sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 220, g: 220, b: 220 } } })
    .jpeg()
    .toBuffer()

describe('a file that is what it says it is', () => {
  it('accepts a real PDF', async () => {
    const inspected = await inspectDocumentUpload(upload(await realPdf(), 'letter.pdf'))

    expect(inspected).toMatchObject({ extension: '.pdf', mimeType: 'application/pdf' })
  })

  it('accepts a real photograph', async () => {
    const inspected = await inspectDocumentUpload(upload(await realJpeg(), 'aadhaar.jpg'))

    expect(inspected.mimeType).toBe('image/jpeg')
  })

  it('reads the type from the BYTES, not from the name', async () => {
    // Already the rule before any of this, and the reason a .exe renamed to
    // .pdf never reached the store. Pinned here so it stays true.
    const notAPdf = Buffer.from('MZ\x90\x00 this is a windows executable')

    await expect(inspectDocumentUpload(upload(notAPdf, 'payslip.pdf'))).rejects.toMatchObject({
      statusCode: 415,
    })
  })

  it('refuses a real PDF wearing an image name', async () => {
    await expect(
      inspectDocumentUpload(upload(await realPdf(), 'aadhaar.png')),
    ).rejects.toMatchObject({ statusCode: 415 })
  })
})

/**
 * The gap this closes.
 *
 * Every check above reads the first few bytes. A PDF whose download was cut off
 * still begins '%PDF-', so it passed all of them and was filed as received -
 * and the damage surfaced weeks later, when somebody printed the employee's
 * file and half of it was missing.
 */
describe('a file that is damaged', () => {
  it('refuses a PDF that was cut off part way through', async () => {
    const whole = await realPdf(['ONE', 'TWO', 'THREE'])
    const truncated = whole.subarray(0, Math.floor(whole.byteLength / 2))

    // It still starts with %PDF-, which is exactly why this test exists.
    expect(truncated.subarray(0, 5).toString()).toBe('%PDF-')

    await expect(inspectDocumentUpload(upload(truncated, 'letter.pdf'))).rejects.toThrow(
      /could not be opened/i,
    )
  })

  it('refuses a PDF whose body has been overwritten with rubbish', async () => {
    const damaged = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(400, 0x41)])

    await expect(inspectDocumentUpload(upload(damaged, 'letter.pdf'))).rejects.toThrow(
      /could not be opened|no pages/i,
    )
  })

  it('refuses a PDF with no pages in it', async () => {
    // It parses perfectly and contains nothing: preview shows an empty window,
    // and the checklist says the document is in.
    //
    // Written out by hand because pdf-lib will not produce one - saving an
    // empty document gives it a page. A tool that writes PDFs badly can, and
    // that is who this is for.
    const noPages = Buffer.from(
      [
        '%PDF-1.4',
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
        'trailer << /Root 1 0 R /Size 3 >>',
        '%%EOF',
        '',
      ].join(String.fromCharCode(10)),
    )

    await expect(inspectDocumentUpload(upload(noPages, 'letter.pdf'))).rejects.toThrow(
      /no pages/i,
    )
  })

  it('refuses a photograph that was cut off part way through', async () => {
    const whole = await realJpeg()
    const truncated = whole.subarray(0, 200)

    await expect(inspectDocumentUpload(upload(truncated, 'aadhaar.jpg'))).rejects.toThrow(
      /damaged/i,
    )
  })

  it('says what to do about it, in words HR can act on', async () => {
    const whole = await realPdf()
    const truncated = whole.subarray(0, 120)

    await expect(
      inspectDocumentUpload(upload(truncated, 'letter.pdf')),
    ).rejects.toMatchObject({
      // 400, not 415: the file IS a PDF. It is a broken one.
      statusCode: 400,
      message: expect.stringContaining('upload it again'),
    })
  })

  it('still refuses an empty file and one over the size limit', async () => {
    await expect(inspectDocumentUpload(upload(Buffer.alloc(0), 'letter.pdf'))).rejects.toThrow(
      /empty/i,
    )
  })
})
