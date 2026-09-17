import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { toPdfUserSpace, type NormalizedRect } from '@asps-dms/shared'
import {
  assessBoxes,
  boxCoverage,
  imagesOnPage,
  inkFraction,
  toGrey,
  type OccupancySettings,
} from '../../src/services/boxOccupancy.service.js'
import * as pdfRaster from '../../src/services/pdfRaster.service.js'
import { openPdf, renderPage } from '../../src/services/pdfRaster.service.js'

/**
 * Is there already something in the box?
 *
 * Real PDFs, built here with pdf-lib, and real pictures, built with sharp, so
 * the operator-list walk, the matrix arithmetic, the rendering and the ink
 * measurement are all the real thing. What is asserted is the rule the office
 * settled on:
 *
 *   digital page  -> an image on the box decides it; nothing else is looked at
 *   scanned page  -> the scan's background is dropped; any smaller image on
 *                    the box decides it; only then is the ink measured
 *   image upload  -> a scanned page
 *
 * and, with the verdicts, the numbers - so a threshold change is a test change.
 */

const PAGE_WIDTH = 600
const PAGE_HEIGHT = 800

/** A signature-sized box, bottom right. */
const BOX: NormalizedRect = { x: 0.6, y: 0.8, width: 0.28, height: 0.09 }

const SETTINGS: OccupancySettings = {
  fullPageMin: 0.5,
  overlapMin: 0.25,
  inkEmptyMax: 0.015,
  inkOccupiedMin: 0.035,
  inkMargin: 40,
  inkCutoffCeiling: 200,
}

/* ------------------------------------------------------------------ fixtures */

/** A flat-colour JPEG. */
async function jpeg(width: number, height: number, grey: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } } })
    .jpeg({ quality: 95 })
    .toBuffer()
}

/**
 * A 'scan': paper of the given brightness, with an optional dark mark drawn
 * inside the box as a scanner would have captured a signature.
 */
async function scanImage(
  paper: number,
  mark: { box: NormalizedRect; darkness: number; fraction: number } | null,
  width = 1200,
  height = 1600,
): Promise<Buffer> {
  const composites: sharp.OverlayOptions[] = []
  if (mark) {
    // A stripe across the middle of the box covering `fraction` of its area.
    const boxW = Math.round(mark.box.width * width)
    const boxH = Math.round(mark.box.height * height)
    const stripeH = Math.max(1, Math.round(boxH * mark.fraction))
    const stripe = await sharp({
      create: { width: boxW, height: stripeH, channels: 3, background: { r: mark.darkness, g: mark.darkness, b: mark.darkness } },
    })
      .png()
      .toBuffer()
    composites.push({
      input: stripe,
      left: Math.round(mark.box.x * width),
      top: Math.round(mark.box.y * height + (boxH - stripeH) / 2),
    })
  }
  return sharp({ create: { width, height, channels: 3, background: { r: paper, g: paper, b: paper } } })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer()
}

/** Draws an image so that it lands exactly on a normalized rect of the page. */
async function drawImageAt(pdf: PDFDocument, page: ReturnType<PDFDocument['addPage']>, image: Buffer, rect: NormalizedRect) {
  const embedded = await pdf.embedJpg(image)
  const target = toPdfUserSpace(rect, PAGE_WIDTH, PAGE_HEIGHT, 0)
  page.drawImage(embedded, { x: target.x, y: target.y, width: target.width, height: target.height })
}

interface PdfOptions {
  /** A full-page 'scan' image, by paper brightness. */
  scan?: { paper: number; mark?: { darkness: number; fraction: number } } | undefined
  /** Smaller images to draw at these rects, as a stamp would be. */
  images?: NormalizedRect[] | undefined
  /** Printed text and lines inside the box, as a form has. */
  formInBox?: boolean | undefined
  rotation?: number | undefined
}

async function makePdf(options: PdfOptions = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  if (options.rotation) page.setRotation(degrees(options.rotation))

  if (options.scan) {
    // The scan is drawn onto the page's own coordinates, box included, so a
    // mark 'in the box' on the picture is in the box on the page.
    const picture = await scanImage(
      options.scan.paper,
      options.scan.mark ? { box: BOX, darkness: options.scan.mark.darkness, fraction: options.scan.mark.fraction } : null,
      PAGE_WIDTH,
      PAGE_HEIGHT,
    )
    await drawImageAt(pdf, page, picture, { x: 0, y: 0, width: 1, height: 1 })
  }

  if (options.formInBox) {
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const target = toPdfUserSpace(BOX, PAGE_WIDTH, PAGE_HEIGHT, 0)
    page.drawText('Signature of employee:', { x: target.x + 4, y: target.y + target.height - 14, size: 10, font })
    page.drawLine({
      start: { x: target.x, y: target.y + 4 },
      end: { x: target.x + target.width, y: target.y + 4 },
      thickness: 1,
      color: rgb(0, 0, 0),
    })
    page.drawRectangle({ x: target.x, y: target.y, width: target.width, height: target.height, borderWidth: 1, borderColor: rgb(0, 0, 0) })
  }

  for (const rect of options.images ?? []) {
    await drawImageAt(pdf, page, await jpeg(300, 100, 30), rect)
  }

  return Buffer.from(await pdf.save())
}

const boxOn = (pageNumber: number) => [{ label: 'employee', pageNumber, rect: BOX }]

/** Whether the page was rendered at all - the ink check is the only thing that does. */
function watchRendering() {
  return vi.spyOn(pdfRaster, 'renderPage')
}

/* -------------------------------------------------------------- image walk */

describe('finding the images on a page', () => {
  it('reports where each image lands, as fractions of the page', async () => {
    const pdf = await openPdf(await makePdf({ images: [BOX, { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }] }))
    const images = await imagesOnPage(await pdf.getPage(1))

    expect(images).toHaveLength(2)
    const onBox = images.find((i) => Math.abs(i.rect.x - BOX.x) < 0.001)
    expect(onBox?.rect.y).toBeCloseTo(BOX.y, 3)
    expect(onBox?.rect.width).toBeCloseTo(BOX.width, 3)
    expect(onBox?.rect.height).toBeCloseTo(BOX.height, 3)
    expect(onBox?.pageFraction).toBeCloseTo(BOX.width * BOX.height, 3)
    await pdf.destroy()
  })

  it('sees a full-page scan as covering the whole page', async () => {
    const pdf = await openPdf(await makePdf({ scan: { paper: 235 } }))
    const images = await imagesOnPage(await pdf.getPage(1))

    expect(images).toHaveLength(1)
    expect(images[0]?.pageFraction).toBeCloseTo(1, 2)
    await pdf.destroy()
  })

  it('finds an image in displayed space on a rotated page', async () => {
    // Drawn at the box in unrotated space; shown rotated 90, it appears
    // elsewhere. Either way it is the same image and is found.
    const pdf = await openPdf(await makePdf({ images: [BOX], rotation: 90 }))
    const images = await imagesOnPage(await pdf.getPage(1))
    expect(images).toHaveLength(1)
    expect(images[0]?.pageFraction).toBeCloseTo(BOX.width * BOX.height, 3)
    await pdf.destroy()
  })

  it('measures how much of the box an image covers, and ignores one outside it', () => {
    expect(boxCoverage(BOX, BOX)).toBeCloseTo(1, 6)
    expect(boxCoverage(BOX, { x: 0.6, y: 0.8, width: 0.14, height: 0.09 })).toBeCloseTo(0.5, 6)
    expect(boxCoverage(BOX, { x: 0.1, y: 0.1, width: 0.2, height: 0.1 })).toBe(0)
    // A page-sized image covers all of it.
    expect(boxCoverage(BOX, { x: 0, y: 0, width: 1, height: 1 })).toBeCloseTo(1, 6)
  })
})

/* ---------------------------------------------------------------- ink */

describe('measuring ink against the page’s own background', () => {
  it('reads blank paper as no ink, whatever shade the scanner made it', async () => {
    for (const paper of [255, 235, 190]) {
      const grey = await toGrey(await scanImage(paper, null))
      const ink = inkFraction(grey, BOX, SETTINGS)
      expect(ink.background, `paper ${paper}`).toBeGreaterThanOrEqual(paper - 3)
      expect(ink.percent, `paper ${paper}`).toBeLessThan(0.5)
    }
  })

  it('reads a mark in the box as ink, in proportion', async () => {
    const grey = await toGrey(await scanImage(235, { box: BOX, darkness: 20, fraction: 0.3 }))
    const ink = inkFraction(grey, BOX, SETTINGS)
    expect(ink.percent).toBeGreaterThan(25)
    expect(ink.percent).toBeLessThan(35)
  })

  it('catches a faint mark a fixed dark cut-off would miss', async () => {
    // Light-grey ink (150) on white paper: darker than 128? No. Darker than
    // the paper by 40? Yes. This is the confirmation letter's faint signature.
    const grey = await toGrey(await scanImage(250, { box: BOX, darkness: 150, fraction: 0.2 }))
    const ink = inkFraction(grey, BOX, SETTINGS)
    expect(ink.cutoff).toBe(200)
    expect(ink.percent).toBeGreaterThan(15)
  })

  it('does not call grey paper ink on a dark scan', async () => {
    // Paper at 170: a fixed cut-off of 200 would call all of it ink. The
    // background-relative cut-off sits at 130 and finds nothing.
    const grey = await toGrey(await scanImage(170, null))
    const ink = inkFraction(grey, BOX, SETTINGS)
    expect(ink.cutoff).toBe(130)
    expect(ink.percent).toBeLessThan(0.5)
  })
})

/* ------------------------------------------------------------ verdicts */

describe('the verdict on a digital page', () => {
  it('is empty when nothing is on the box, and the ink check does not run', async () => {
    const rendered = watchRendering()
    const [result] = await assessBoxes(await makePdf(), 'application/pdf', boxOn(1), SETTINGS)
    expect(result).toMatchObject({ verdict: 'empty', decidedBy: 'none', pageKind: 'digital' })
    expect(result?.ink).toBeUndefined()
    expect(rendered).not.toHaveBeenCalled()
    rendered.mockRestore()
  })

  it('is empty when the box holds only printed text and table lines - the form, not a signature', async () => {
    const rendered = watchRendering()
    const [result] = await assessBoxes(await makePdf({ formInBox: true }), 'application/pdf', boxOn(1), SETTINGS)
    expect(result).toMatchObject({ verdict: 'empty', decidedBy: 'none', pageKind: 'digital' })
    expect(result?.ink).toBeUndefined()
    // The page was never rendered: on a digital page the ink is not looked at.
    expect(rendered).not.toHaveBeenCalled()
    rendered.mockRestore()
  })

  it('is occupied when an image sits on the box', async () => {
    const [result] = await assessBoxes(await makePdf({ images: [BOX] }), 'application/pdf', boxOn(1), SETTINGS)
    expect(result).toMatchObject({ verdict: 'occupied', decidedBy: 'image', pageKind: 'digital' })
    expect(result?.overlap.coverage).toBeCloseTo(1, 2)
  })

  it('ignores an image elsewhere on the page', async () => {
    const [result] = await assessBoxes(
      await makePdf({ images: [{ x: 0.1, y: 0.1, width: 0.28, height: 0.09 }] }),
      'application/pdf',
      boxOn(1),
      SETTINGS,
    )
    expect(result).toMatchObject({ verdict: 'empty', overlap: { images: 0, coverage: 0 } })
  })

  it('needs the image to cover enough of the box', async () => {
    // A sliver on the corner is not a signature in the box.
    const sliver = { x: BOX.x, y: BOX.y, width: BOX.width * 0.2, height: BOX.height * 0.5 }
    const [result] = await assessBoxes(await makePdf({ images: [sliver] }), 'application/pdf', boxOn(1), SETTINGS)
    expect(result?.overlap.coverage).toBeCloseTo(0.1, 2)
    expect(result?.verdict).toBe('empty')
  })

  it('decides each box on its own', async () => {
    const other: NormalizedRect = { x: 0.1, y: 0.8, width: 0.28, height: 0.09 }
    const results = await assessBoxes(
      await makePdf({ images: [BOX] }),
      'application/pdf',
      [
        { label: 'employee', signerRole: 'Employee', pageNumber: 1, rect: BOX },
        { label: 'hr', signerRole: 'Authoriser', pageNumber: 1, rect: other },
      ],
      SETTINGS,
    )
    expect(results.map((r) => [r.label, r.verdict])).toEqual([
      ['employee', 'occupied'],
      ['hr', 'empty'],
    ])
  })
})

describe('the verdict on a scanned page', () => {
  it('is empty when the box on the scan is blank paper', async () => {
    const [result] = await assessBoxes(await makePdf({ scan: { paper: 235 } }), 'application/pdf', boxOn(1), SETTINGS)
    expect(result).toMatchObject({ verdict: 'empty', pageKind: 'scanned' })
    // The background image was dropped, not counted.
    expect(result?.overlap).toEqual({ images: 0, coverage: 0 })
    expect(result?.ink?.percent).toBeLessThan(0.5)
  })

  it('is occupied by ink when the scan has a mark in the box', async () => {
    const [result] = await assessBoxes(
      await makePdf({ scan: { paper: 235, mark: { darkness: 20, fraction: 0.3 } } }),
      'application/pdf',
      boxOn(1),
      SETTINGS,
    )
    expect(result).toMatchObject({ verdict: 'occupied', decidedBy: 'ink', pageKind: 'scanned' })
    expect(result?.ink?.percent).toBeGreaterThan(20)
  })

  it('is occupied by image - without rendering - when a stamp sits on the scan', async () => {
    const rendered = watchRendering()
    const [result] = await assessBoxes(
      await makePdf({ scan: { paper: 235 }, images: [BOX] }),
      'application/pdf',
      boxOn(1),
      SETTINGS,
    )
    expect(result).toMatchObject({ verdict: 'occupied', decidedBy: 'image', pageKind: 'scanned' })
    expect(result?.overlap.coverage).toBeCloseTo(1, 2)
    // No ink measurement was taken: the image decided it first.
    expect(result?.ink).toBeUndefined()
    expect(rendered).not.toHaveBeenCalled()
    rendered.mockRestore()
  })

  it('renders exactly once for a page with several boxes needing the ink check', async () => {
    const rendered = watchRendering()
    const results = await assessBoxes(
      await makePdf({ scan: { paper: 235 } }),
      'application/pdf',
      [
        { label: 'a', pageNumber: 1, rect: BOX },
        { label: 'b', pageNumber: 1, rect: { x: 0.1, y: 0.8, width: 0.28, height: 0.09 } },
      ],
      SETTINGS,
    )
    expect(results.map((r) => r.verdict)).toEqual(['empty', 'empty'])
    expect(rendered).toHaveBeenCalledTimes(1)
    rendered.mockRestore()
  })

  it('is uncertain in the band between empty and occupied', async () => {
    // A very thin mark: ~2.5% of the box.
    const [result] = await assessBoxes(
      await makePdf({ scan: { paper: 235, mark: { darkness: 20, fraction: 0.025 } } }),
      'application/pdf',
      boxOn(1),
      SETTINGS,
    )
    expect(result?.verdict).toBe('uncertain')
    expect(result?.ink?.percent).toBeGreaterThan(1.5)
    expect(result?.ink?.percent).toBeLessThan(3.5)
  })

  it('treats a large logo under the limit as an image, and one over it as the background', async () => {
    const big = { x: 0.05, y: 0.05, width: 0.9, height: 0.5 } // 45% of the page
    const bigger = { x: 0.05, y: 0.05, width: 0.9, height: 0.6 } // 54%
    const boxInside = [{ label: 'x', pageNumber: 1, rect: { x: 0.1, y: 0.1, width: 0.28, height: 0.09 } }]

    const [logo] = await assessBoxes(await makePdf({ images: [big] }), 'application/pdf', boxInside, SETTINGS)
    expect(logo).toMatchObject({ verdict: 'occupied', decidedBy: 'image', pageKind: 'digital' })

    const [scan] = await assessBoxes(await makePdf({ images: [bigger] }), 'application/pdf', boxInside, SETTINGS)
    expect(scan?.pageKind).toBe('scanned')
    expect(scan?.overlap.images).toBe(0)
  })
})

describe('the verdict on an image upload', () => {
  it('is a scanned page: empty on blank paper, occupied with a mark', async () => {
    const [empty] = await assessBoxes(await scanImage(235, null), 'image/jpeg', boxOn(1), SETTINGS)
    expect(empty).toMatchObject({ verdict: 'empty', pageKind: 'scanned' })

    const [marked] = await assessBoxes(
      await scanImage(235, { box: BOX, darkness: 20, fraction: 0.3 }),
      'image/jpeg',
      boxOn(1),
      SETTINGS,
    )
    expect(marked).toMatchObject({ verdict: 'occupied', decidedBy: 'ink', pageKind: 'scanned' })
  })
})

describe('edge cases', () => {
  it('answers uncertain for a page the document does not have', async () => {
    const [result] = await assessBoxes(await makePdf(), 'application/pdf', boxOn(3), SETTINGS)
    expect(result?.verdict).toBe('uncertain')
    expect(result?.reason).toContain('no page 3')
  })

  it('answers nothing for no boxes, without opening the file', async () => {
    expect(await assessBoxes(Buffer.from('not a pdf'), 'application/pdf', [], SETTINGS)).toEqual([])
  })
})

describe('the shared renderer', () => {
  it('draws a page at the standard scale on a white ground', async () => {
    const pdf = await openPdf(await makePdf())
    const png = await renderPage(await pdf.getPage(1))
    const meta = await sharp(png).metadata()
    expect(meta.width).toBe(PAGE_WIDTH * 2)
    expect(meta.height).toBe(PAGE_HEIGHT * 2)
    const grey = await toGrey(png)
    expect(inkFraction(grey, { x: 0, y: 0, width: 1, height: 1 }, SETTINGS).background).toBe(255)
    await pdf.destroy()
  })
})
