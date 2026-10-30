import { PDFDocument, degrees } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { uprightDocumentImage } from '../../src/services/imagePrep.service.js'
import { openPdf, renderPage } from '../../src/services/pdfRaster.service.js'
import {
  IMAGE_PAGE_MAX_PT,
  fitInside,
  imagePageSize,
  toDrawParams,
  stampSignature,
} from '../../src/services/signatureStamp.service.js'

/**
 * Drawing a signature onto a page.
 *
 * docs/coordinate-system.md pins a 10% square at the DISPLAYED top-left corner
 * of a 600 x 800 page to a known corner of the unrotated page, at each of the
 * four rotations. Those absolute values are asserted here as well, one step
 * further on: what pdf-lib is actually told to draw.
 *
 * Absolute values rather than a round trip, deliberately. A round trip confirms
 * only that a transform is self-consistent, and an inverted axis is perfectly
 * self-consistent.
 */

const PAGE_WIDTH = 600
const PAGE_HEIGHT = 800

/** A 10% square at the displayed top-left corner. */
const TOP_LEFT_SQUARE = { x: 0, y: 0, width: 0.1, height: 0.1 }

/** 1x1 transparent PNG - the smallest thing pdf-lib will embed. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('toDrawParams', () => {
  it('draws at the top-left of an unrotated page, with no image rotation', () => {
    expect(toDrawParams(TOP_LEFT_SQUARE, PAGE_WIDTH, PAGE_HEIGHT, 0)).toEqual({
      x: 0,
      y: 720,
      width: 60,
      height: 80,
      rotate: 0,
    })
  })

  it('counter-rotates the image on a page rotated 90', () => {
    // The target rect is the bottom-left corner (x=0, y=0, 60x80). The image is
    // anchored at that rect's RIGHT edge because pdf-lib rotates about (x, y),
    // and its own width and height are swapped: after a 90 degree turn the
    // image's width runs up the page.
    expect(toDrawParams(TOP_LEFT_SQUARE, PAGE_WIDTH, PAGE_HEIGHT, 90)).toEqual({
      x: 60,
      y: 0,
      width: 80,
      height: 60,
      rotate: 90,
    })
  })

  it('counter-rotates the image on a page rotated 180', () => {
    expect(toDrawParams(TOP_LEFT_SQUARE, PAGE_WIDTH, PAGE_HEIGHT, 180)).toEqual({
      x: 600,
      y: 80,
      width: 60,
      height: 80,
      rotate: 180,
    })
  })

  it('counter-rotates the image on a page rotated 270', () => {
    expect(toDrawParams(TOP_LEFT_SQUARE, PAGE_WIDTH, PAGE_HEIGHT, 270)).toEqual({
      x: 540,
      y: 800,
      width: 80,
      height: 60,
      rotate: 270,
    })
  })

  it('keeps the drawn image inside the page at every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const rect of [
        { x: 0.7, y: 0.8, width: 0.25, height: 0.15 },
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      ]) {
        const covered = coveredRect(toDrawParams(rect, PAGE_WIDTH, PAGE_HEIGHT, rotation))

        expect(covered.left).toBeGreaterThanOrEqual(-0.0001)
        expect(covered.bottom).toBeGreaterThanOrEqual(-0.0001)
        expect(covered.right).toBeLessThanOrEqual(PAGE_WIDTH + 0.0001)
        expect(covered.top).toBeLessThanOrEqual(PAGE_HEIGHT + 0.0001)
      }
    }
  })
})

/**
 * The area a set of draw parameters actually covers.
 *
 * pdf-lib rotates about (x, y) counter-clockwise, so the anchor is a different
 * corner of the covered area at each rotation. Working that out here, rather
 * than assuming it, is what makes the containment check mean anything.
 */
function coveredRect(draw: ReturnType<typeof toDrawParams>) {
  switch (draw.rotate) {
    case 0:
      return {
        left: draw.x,
        right: draw.x + draw.width,
        bottom: draw.y,
        top: draw.y + draw.height,
      }
    case 90:
      return {
        left: draw.x - draw.height,
        right: draw.x,
        bottom: draw.y,
        top: draw.y + draw.width,
      }
    case 180:
      return {
        left: draw.x - draw.width,
        right: draw.x,
        bottom: draw.y - draw.height,
        top: draw.y,
      }
    case 270:
      return {
        left: draw.x,
        right: draw.x + draw.height,
        bottom: draw.y - draw.width,
        top: draw.y,
      }
  }
}

async function makePdf(pageCount: number, rotation = 0): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    if (rotation !== 0) page.setRotation(degrees(rotation))
  }
  return Buffer.from(await pdf.save())
}

describe('fitInside', () => {
  // A passport photograph - 3:4 portrait - into the ESIC form's landscape box.
  const PORTRAIT = { width: 1200, height: 1600 }
  // A box 30% wide and 10% tall on a 600 x 800 page: 180 x 80 points.
  const LANDSCAPE_BOX = { x: 0.6, y: 0.1, width: 0.3, height: 0.1 }

  it('keeps the photograph its own shape, touching the box top and bottom', () => {
    const fitted = fitInside(LANDSCAPE_BOX, PORTRAIT, PAGE_WIDTH, PAGE_HEIGHT, 0)

    // Height is the limit: 80 points tall, so 60 points wide at 3:4.
    expect(fitted.height).toBeCloseTo(80 / PAGE_HEIGHT, 6)
    expect(fitted.width).toBeCloseTo(60 / PAGE_WIDTH, 6)
    // The drawn shape is the image's, never the box's.
    expect((fitted.width * PAGE_WIDTH) / (fitted.height * PAGE_HEIGHT)).toBeCloseTo(0.75, 6)
  })

  it('centres it, with the spare room split either side', () => {
    const fitted = fitInside(LANDSCAPE_BOX, PORTRAIT, PAGE_WIDTH, PAGE_HEIGHT, 0)

    // 180 wide, 60 used: 60 spare each side.
    expect(fitted.x).toBeCloseTo(LANDSCAPE_BOX.x + 60 / PAGE_WIDTH, 6)
    expect(fitted.y).toBeCloseTo(LANDSCAPE_BOX.y, 6)
  })

  it('never leaves the box', () => {
    for (const image of [PORTRAIT, { width: 1600, height: 1200 }, { width: 500, height: 500 }]) {
      const fitted = fitInside(LANDSCAPE_BOX, image, PAGE_WIDTH, PAGE_HEIGHT, 0)
      expect(fitted.x).toBeGreaterThanOrEqual(LANDSCAPE_BOX.x - 1e-9)
      expect(fitted.y).toBeGreaterThanOrEqual(LANDSCAPE_BOX.y - 1e-9)
      expect(fitted.x + fitted.width).toBeLessThanOrEqual(LANDSCAPE_BOX.x + LANDSCAPE_BOX.width + 1e-9)
      expect(fitted.y + fitted.height).toBeLessThanOrEqual(LANDSCAPE_BOX.y + LANDSCAPE_BOX.height + 1e-9)
    }
  })

  it('measures the box in the DISPLAYED page, so a rotated page does not squash it', () => {
    // On a page shown rotated 90, the displayed page is 800 wide and 600 tall,
    // so the same normalized box is 240 x 60 points as the person saw it.
    const fitted = fitInside(LANDSCAPE_BOX, PORTRAIT, PAGE_WIDTH, PAGE_HEIGHT, 90)

    expect(fitted.height).toBeCloseTo(60 / PAGE_WIDTH, 6)
    expect(fitted.width).toBeCloseTo(45 / PAGE_HEIGHT, 6)
    expect((fitted.width * PAGE_HEIGHT) / (fitted.height * PAGE_WIDTH)).toBeCloseTo(0.75, 6)
  })
})

describe('stampSignature', () => {
  const placement = {
    pageNumber: 1,
    rect: TOP_LEFT_SQUARE,
    pageRotation: 0 as const,
  }

  it('returns a PDF with the same pages as the original', async () => {
    const source = await makePdf(3)

    const output = await stampSignature({
      source,
      sourceMimeType: 'application/pdf',
      signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
      placements: [{ ...placement, pageNumber: 2 }],
    })

    expect(output.subarray(0, 5).toString()).toBe('%PDF-')
    const reopened = await PDFDocument.load(output)
    expect(reopened.getPageCount()).toBe(3)
    // The page keeps its size: stamping draws onto the page, it does not rebuild it.
    expect(reopened.getPage(1).getSize()).toEqual({ width: PAGE_WIDTH, height: PAGE_HEIGHT })
  })

  it('draws a photograph box from the Photo image, not the signature', async () => {
    const source = await makePdf(1)

    const output = await stampSignature({
      source,
      sourceMimeType: 'application/pdf',
      signatures: { Photo: { data: PNG_1X1, mimeType: 'image/png' } },
      placements: [{ ...placement, signerRole: 'Photo' }],
    })

    expect(output.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('refuses a photograph box when no photograph was supplied', async () => {
    const source = await makePdf(1)

    await expect(
      stampSignature({
        source,
        sourceMimeType: 'application/pdf',
        signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
        placements: [{ ...placement, signerRole: 'Photo' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('photograph') })
  })

  it('turns an image document into a one-page PDF sized to the image', async () => {
    const output = await stampSignature({
      source: PNG_1X1,
      sourceMimeType: 'image/png',
      signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
      placements: [placement],
    })

    const reopened = await PDFDocument.load(output)
    expect(reopened.getPageCount()).toBe(1)
    expect(reopened.getPage(0).getSize()).toEqual({ width: 1, height: 1 })
  })

  it('stamps a rotated page without complaint when the rotation still matches', async () => {
    const source = await makePdf(1, 90)

    const output = await stampSignature({
      source,
      sourceMimeType: 'application/pdf',
      signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
      placements: [{ ...placement, pageRotation: 90 }],
    })

    expect((await PDFDocument.load(output)).getPageCount()).toBe(1)
  })

  it('refuses to draw when the page has been rotated since the placement was made', async () => {
    const source = await makePdf(1, 90)

    // The coordinates describe the page as HR saw it. If the page has turned,
    // they now describe somewhere else - and a signature in the wrong place on
    // a real document is the failure this module exists to prevent.
    await expect(
      stampSignature({
        source,
        sourceMimeType: 'application/pdf',
        signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
        placements: [{ ...placement, pageRotation: 0 }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('refuses a placement on a page the document does not have', async () => {
    const source = await makePdf(2)

    await expect(
      stampSignature({
        source,
        sourceMimeType: 'application/pdf',
        signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
        placements: [{ ...placement, pageNumber: 7 }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('says a PDF cannot be edited rather than failing obscurely', async () => {
    await expect(
      stampSignature({
        source: Buffer.from('not a pdf at all'),
        sourceMimeType: 'application/pdf',
        signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
        placements: [placement],
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('says the signature image is the problem when it cannot be embedded', async () => {
    const source = await makePdf(1)

    await expect(
      stampSignature({
        source,
        sourceMimeType: 'application/pdf',
        signatures: { Employee: { data: Buffer.from('not an image'), mimeType: 'image/png' } },
        placements: [placement],
      }),
    ).rejects.toMatchObject({
      statusCode: 415,
      message: expect.stringContaining('signature image'),
    })
  })

  it('says the photograph is the problem when that is what would not embed', async () => {
    const source = await makePdf(1)

    await expect(
      stampSignature({
        source,
        sourceMimeType: 'application/pdf',
        signatures: { Photo: { data: Buffer.from('not an image'), mimeType: 'image/jpeg' } },
        placements: [{ ...placement, signerRole: 'Photo' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 415,
      message: expect.stringContaining('photograph'),
    })
  })
})

/**
 * An image document, the right way up.
 *
 * A phone photo's pixels are usually stored on their side with an EXIF note
 * saying which way to turn them. The browser obeys the note, so HR places the
 * box on the upright picture; the occupancy check reads it upright too. The
 * stamp drew the raw pixels, so the signature landed somewhere else on the
 * signed copy, with no error. These draw a real picture and look at the
 * signed page.
 */
describe('stamping an image document', () => {
  /** The picture as HR sees it: 200 wide, 300 tall, a blue mark in the bottom-right corner. */
  async function uprightCard(): Promise<Buffer> {
    const blue = await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#0000ff' },
    })
      .png()
      .toBuffer()
    return sharp({ create: { width: 200, height: 300, channels: 3, background: '#ffffff' } })
      .composite([{ input: blue, left: 150, top: 250 }])
      .png()
      .toBuffer()
  }

  /**
   * The same picture as a phone stores it: the pixels turned a quarter left,
   * with EXIF orientation 6 - 'turn me a quarter right to view'.
   */
  async function asPhoneStoresIt(upright: Buffer): Promise<Buffer> {
    return sharp(upright).rotate(270).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer()
  }

  /** A solid red signature, so where it landed can be seen. */
  const redSignature = () =>
    sharp({ create: { width: 60, height: 20, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer()

  /** The colour at a point given as fractions of the rendered page. */
  async function colourAt(pdf: Buffer, fx: number, fy: number): Promise<[number, number, number]> {
    const doc = await openPdf(pdf)
    const png = await renderPage(await doc.getPage(1), 1)
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    const x = Math.min(info.width - 1, Math.floor(fx * info.width))
    const y = Math.min(info.height - 1, Math.floor(fy * info.height))
    const at = (y * info.width + x) * info.channels
    return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0]
  }

  const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 60 && b < 60
  const isBlue = ([r, g, b]: [number, number, number]) => b > 200 && r < 60 && g < 60

  it('puts the signature where HR placed it on the upright picture, from an EXIF-rotated JPEG', async () => {
    const stored = await asPhoneStoresIt(await uprightCard())
    // The precondition: stored sideways, upright only by its EXIF note.
    const raw = await sharp(stored).metadata()
    expect([raw.width, raw.height, raw.orientation]).toEqual([300, 200, 6])

    // HR draws the box at the top-left of the upright picture.
    const box = { x: 0.05, y: 0.05, width: 0.4, height: 0.15 }
    const output = await stampSignature({
      source: stored,
      sourceMimeType: 'image/jpeg',
      signatures: { Employee: { data: await redSignature(), mimeType: 'image/png' } },
      placements: [{ pageNumber: 1, rect: box, pageRotation: 0 }],
    })

    // The signed page is the upright picture: portrait, 2:3.
    const page = (await PDFDocument.load(output)).getPage(0).getSize()
    expect(page.height / page.width).toBeCloseTo(1.5, 2)
    // The signature is in the box HR drew ...
    expect(isRed(await colourAt(output, 0.25, 0.125))).toBe(true)
    // ... and the picture is the right way up around it: the blue mark is in
    // the bottom-right corner, where HR saw it, and nowhere near the box.
    expect(isBlue(await colourAt(output, 0.87, 0.9))).toBe(true)
    expect(isRed(await colourAt(output, 0.87, 0.9))).toBe(false)
  })

  it('makes no page larger than A4, keeping the picture’s own proportions', async () => {
    expect(imagePageSize(4000, 3000)).toEqual({ width: IMAGE_PAGE_MAX_PT, height: IMAGE_PAGE_MAX_PT * 0.75 })
    expect(imagePageSize(3000, 4000)).toEqual({ width: IMAGE_PAGE_MAX_PT * 0.75, height: IMAGE_PAGE_MAX_PT })
    // A small scan is left at its own size, never blown up.
    expect(imagePageSize(600, 400)).toEqual({ width: 600, height: 400 })
  })

  it('signs a phone photo on an A4-sized page, not one a metre wide', async () => {
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#eeeeee' } })
      .jpeg()
      .toBuffer()
    const output = await stampSignature({
      source: photo,
      sourceMimeType: 'image/jpeg',
      signatures: { Employee: { data: PNG_1X1, mimeType: 'image/png' } },
      placements: [{ pageNumber: 1, rect: TOP_LEFT_SQUARE, pageRotation: 0 }],
    })
    const page = (await PDFDocument.load(output)).getPage(0).getSize()
    expect(page.width).toBeCloseTo(IMAGE_PAGE_MAX_PT, 2)
    expect(page.height).toBeCloseTo(IMAGE_PAGE_MAX_PT * 0.75, 2)
  })

  it.each([
    ['WebP', 'image/webp', (s: sharp.Sharp) => s.webp()],
    ['TIFF', 'image/tiff', (s: sharp.Sharp) => s.tiff()],
  ] as const)('signs a %s document, which the upload accepts', async (_name, mimeType, encode) => {
    const source = await encode(
      sharp({ create: { width: 200, height: 300, channels: 3, background: '#ffffff' } }),
    ).toBuffer()
    const output = await stampSignature({
      source,
      sourceMimeType: mimeType,
      signatures: { Employee: { data: await redSignature(), mimeType: 'image/png' } },
      placements: [{ pageNumber: 1, rect: { x: 0.05, y: 0.05, width: 0.4, height: 0.15 }, pageRotation: 0 }],
    })
    expect(isRed(await colourAt(output, 0.25, 0.125))).toBe(true)
  })
})

describe('uprightDocumentImage', () => {
  it('passes an upright baseline JPEG through byte for byte - no second round of loss', async () => {
    const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#808080' } })
      .jpeg({ progressive: false })
      .toBuffer()
    const upright = await uprightDocumentImage(jpeg, 'image/jpeg')
    expect(upright.buffer.equals(jpeg)).toBe(true)
    expect([upright.widthPx, upright.heightPx]).toEqual([30, 20])
  })

  it('turns a rotated JPEG upright, by its EXIF note, and says its upright size', async () => {
    const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#808080' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const upright = await uprightDocumentImage(jpeg, 'image/jpeg')
    const meta = await sharp(upright.buffer).metadata()
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([20, 30, 1])
    expect([upright.widthPx, upright.heightPx]).toEqual([20, 30])
  })
})
