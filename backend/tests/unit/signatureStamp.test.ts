import { PDFDocument, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { toDrawParams, stampSignature } from '../../src/services/signatureStamp.service.js'

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
      signature: PNG_1X1,
      signatureMimeType: 'image/png',
      placements: [{ ...placement, pageNumber: 2 }],
    })

    expect(output.subarray(0, 5).toString()).toBe('%PDF-')
    const reopened = await PDFDocument.load(output)
    expect(reopened.getPageCount()).toBe(3)
    // The page keeps its size: stamping draws onto the page, it does not rebuild it.
    expect(reopened.getPage(1).getSize()).toEqual({ width: PAGE_WIDTH, height: PAGE_HEIGHT })
  })

  it('turns an image document into a one-page PDF sized to the image', async () => {
    const output = await stampSignature({
      source: PNG_1X1,
      sourceMimeType: 'image/png',
      signature: PNG_1X1,
      signatureMimeType: 'image/png',
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
      signature: PNG_1X1,
      signatureMimeType: 'image/png',
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
        signature: PNG_1X1,
        signatureMimeType: 'image/png',
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
        signature: PNG_1X1,
        signatureMimeType: 'image/png',
        placements: [{ ...placement, pageNumber: 7 }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('says a PDF cannot be edited rather than failing obscurely', async () => {
    await expect(
      stampSignature({
        source: Buffer.from('not a pdf at all'),
        sourceMimeType: 'application/pdf',
        signature: PNG_1X1,
        signatureMimeType: 'image/png',
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
        signature: Buffer.from('not an image'),
        signatureMimeType: 'image/png',
        placements: [placement],
      }),
    ).rejects.toMatchObject({ statusCode: 415 })
  })
})
