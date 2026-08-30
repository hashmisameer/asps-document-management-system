/**
 * Signature coordinate system.
 *
 * THE CONTRACT
 * ------------
 * A placement is stored as { x, y, width, height } NORMALIZED to 0..1 in
 * DISPLAYED page space: the page exactly as HR sees it in the editor, with a
 * TOP-LEFT origin, x to the right and y downwards. The page's /Rotate value is
 * stored alongside it as `pageRotation`.
 *
 * Nothing about zoom level, screen DPI, canvas size or render scale is ever
 * stored. That is what makes a placement reproducible across a 96 DPI laptop
 * screen, a 150% zoom and a 300 DPI raster of the same page.
 *
 * Two conversions exist, and only two:
 *
 *   editor px  <-> normalized        (fromRenderedRect / toRenderedRect)
 *   normalized  -> PDF user space    (toPdfUserSpace)
 *
 * PDF user space has a BOTTOM-LEFT origin and is measured in points against
 * the UNROTATED MediaBox, which is the space pdf-lib draws into. toPdfUserSpace
 * performs both the Y-axis flip and the un-rotation.
 */

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** A rect in PDF user space: bottom-left origin, points, unrotated page. */
export interface PdfRect {
  x: number
  y: number
  width: number
  height: number
}

export type PageRotation = 0 | 90 | 180 | 270

/** Normalises any /Rotate value (may be negative or >360) to 0|90|180|270. */
export function normalizeRotation(rotate: number): PageRotation {
  const r = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360
  return r as PageRotation
}

/**
 * Displayed page dimensions for a page of unrotated size W x H.
 * At 90 or 270 degrees the page is presented with its axes swapped.
 */
export function displayedPageSize(
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight }
}

/** Editor pixels -> normalized. `rendered` is the on-screen page box size. */
export function fromRenderedRect(
  rect: PixelRect,
  rendered: { width: number; height: number },
): NormalizedRect {
  assertPositive(rendered.width, 'rendered.width')
  assertPositive(rendered.height, 'rendered.height')
  return {
    x: rect.x / rendered.width,
    y: rect.y / rendered.height,
    width: rect.width / rendered.width,
    height: rect.height / rendered.height,
  }
}

/** Normalized -> editor pixels, for any zoom level or raster scale. */
export function toRenderedRect(
  rect: NormalizedRect,
  rendered: { width: number; height: number },
): PixelRect {
  return {
    x: rect.x * rendered.width,
    y: rect.y * rendered.height,
    width: rect.width * rendered.width,
    height: rect.height * rendered.height,
  }
}

/**
 * Normalized displayed-space rect -> PDF user space (bottom-left origin,
 * points, unrotated page). This is the rect handed straight to pdf-lib's
 * drawImage.
 *
 * `pageWidth` / `pageHeight` are the UNROTATED MediaBox dimensions in points.
 */
export function toPdfUserSpace(
  rect: NormalizedRect,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation = 0,
): PdfRect {
  assertPositive(pageWidth, 'pageWidth')
  assertPositive(pageHeight, 'pageHeight')

  const displayed = displayedPageSize(pageWidth, pageHeight, rotation)

  // Displayed-space rect in points.
  const dx = rect.x * displayed.width
  const dy = rect.y * displayed.height
  const dw = rect.width * displayed.width
  const dh = rect.height * displayed.height

  switch (rotation) {
    case 0:
      // Y-axis flip only: PDF y measures up from the bottom edge.
      return { x: dx, y: pageHeight - dy - dh, width: dw, height: dh }
    case 90:
      return { x: dy, y: dx, width: dh, height: dw }
    case 180:
      return { x: pageWidth - dx - dw, y: dy, width: dw, height: dh }
    case 270:
      return { x: pageWidth - dy - dh, y: pageHeight - dx - dw, width: dh, height: dw }
  }
}

/**
 * Inverse of toPdfUserSpace. Used to show OCR/CV hits - which are found on the
 * rendered raster and reported in PDF space - back in the editor, and by the
 * round-trip test that guards this whole module.
 */
export function fromPdfUserSpace(
  rect: PdfRect,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation = 0,
): NormalizedRect {
  assertPositive(pageWidth, 'pageWidth')
  assertPositive(pageHeight, 'pageHeight')

  const displayed = displayedPageSize(pageWidth, pageHeight, rotation)

  let dx: number
  let dy: number
  let dw: number
  let dh: number

  switch (rotation) {
    case 0:
      dx = rect.x
      dy = pageHeight - rect.y - rect.height
      dw = rect.width
      dh = rect.height
      break
    case 90:
      dx = rect.y
      dy = rect.x
      dw = rect.height
      dh = rect.width
      break
    case 180:
      dx = pageWidth - rect.x - rect.width
      dy = rect.y
      dw = rect.width
      dh = rect.height
      break
    case 270:
      dx = pageHeight - rect.y - rect.height
      dy = pageWidth - rect.x - rect.width
      dw = rect.height
      dh = rect.width
      break
  }

  return {
    x: dx / displayed.width,
    y: dy / displayed.height,
    width: dw / displayed.width,
    height: dh / displayed.height,
  }
}

/** Keeps a placement fully inside the page after a drag or resize. */
export function clampToPage(rect: NormalizedRect): NormalizedRect {
  const width = clamp(rect.width, MIN_PLACEMENT_SIZE, 1)
  const height = clamp(rect.height, MIN_PLACEMENT_SIZE, 1)
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  }
}

/** Guards against a placement being resized into invisibility. */
export const MIN_PLACEMENT_SIZE = 0.01

/** Intersection-over-union, used to de-duplicate OCR and CV candidates. */
export function intersectionOverUnion(a: NormalizedRect, b: NormalizedRect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return 0
  const intersection = (x2 - x1) * (y2 - y1)
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, received ${value}`)
  }
}
