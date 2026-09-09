/**
 * Turning what was drawn on the pad into an image worth storing.
 *
 * The pad's canvas is a wide rectangle because a person needs room to write in;
 * the signature inside it is usually much smaller and rarely centred. Storing
 * the canvas as drawn would store mostly empty space, and every later decision
 * is made from that image: its pixel size fixes the aspect ratio of the box HR
 * drags on the page, and the stamper scales the whole image into that box. A
 * signature with a wide empty margin therefore comes out small and floating.
 *
 * So the ink is cropped to its own bounds before it is uploaded. These helpers
 * are the part of that with no canvas in it, which is the part worth testing.
 */

export interface InkBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The bounding box of everything drawn, or null for an untouched canvas.
 *
 * `data` is RGBA, as getImageData returns it. Only alpha is read: the ink may
 * be any colour, but nothing was drawn where alpha is zero.
 *
 * The threshold ignores the nearly-transparent fringe that antialiasing leaves
 * around a stroke. Without it the bounds creep out by a pixel or two, which is
 * harmless, but a single stray pixel from a barely-touched pen would also count
 * as a signature, which is not.
 */
export function inkBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 12,
): InkBounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0
      if (alpha < alphaThreshold) continue

      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0 || maxY < 0) return null

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Grows the box by a margin, without leaving the canvas.
 *
 * A crop tight against the ink clips the outer edge of an antialiased stroke
 * and looks shaved. A few pixels of transparent margin costs nothing and keeps
 * the signature off the very edge of the box it is later drawn into.
 */
export function padBounds(
  bounds: InkBounds,
  margin: number,
  width: number,
  height: number,
): InkBounds {
  const x = Math.max(0, bounds.x - margin)
  const y = Math.max(0, bounds.y - margin)
  return {
    x,
    y,
    width: Math.min(width - x, bounds.width + (bounds.x - x) + margin),
    height: Math.min(height - y, bounds.height + (bounds.y - y) + margin),
  }
}

/**
 * How wide the stroke is for a given pen pressure.
 *
 * A signature pad that draws one constant width looks like a line, not like
 * ink. The XP-Pen reports real pressure through the Windows pen driver; a mouse
 * reports a constant 0.5, and a pen with no pressure support reports 0 - both
 * of which land on the middle width, which is exactly what they should look
 * like rather than a special case somewhere else in the code.
 */
export function strokeWidth(pressure: number, min: number, max: number): number {
  const usable = pressure > 0 && pressure <= 1 ? pressure : 0.5
  return min + (max - min) * usable
}

/* -------------------------------------------------------------------------- */
/* A signature that arrives as a file rather than as ink                       */
/* -------------------------------------------------------------------------- */

/**
 * The two formats a signature may be uploaded in.
 *
 * The same two the server accepts (ALLOWED_SIGNATURE_MIME_TYPES), because a
 * file this rejects should never have been offered and a file it accepts must
 * not be refused on arrival.
 */
export type UploadedImageType = 'image/png' | 'image/jpeg'

/** How many bytes imageTypeOf needs to see. */
export const IMAGE_HEADER_BYTES = 8

/* The bytes each format begins with. Fixed by the formats themselves: every
   PNG in the world starts with the first, every JPEG with the second. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

/**
 * What a file actually IS, read from the bytes it begins with.
 *
 * NOT from its name. Renaming payslip.pdf to signature.png changes the name and
 * nothing else, and a browser will happily report the type the name implies -
 * so the name is worth nothing here. These first few bytes are written by
 * whatever produced the file and are the only thing that says what it is.
 *
 * Null for anything else, which the caller turns into a refusal.
 */
export function imageTypeOf(header: Uint8Array): UploadedImageType | null {
  const startsWith = (magic: readonly number[]): boolean =>
    header.length >= magic.length && magic.every((byte, index) => header[index] === byte)

  if (startsWith(PNG_MAGIC)) return 'image/png'
  if (startsWith(JPEG_MAGIC)) return 'image/jpeg'
  return null
}

/**
 * How bright a pixel has to be before it counts as paper rather than ink.
 *
 * 200 of 255 suits a scan of a white page. A photograph taken in poor light
 * needs it lower; a page that is grey rather than white needs it higher, which
 * is why the pad puts it on a slider instead of fixing it here.
 */
export const DEFAULT_BACKGROUND_THRESHOLD = 200
export const MIN_BACKGROUND_THRESHOLD = 100
export const MAX_BACKGROUND_THRESHOLD = 254

/**
 * Takes the paper away and leaves the ink.
 *
 * A signature drawn on the pad already has a transparent background, so it sits
 * ON a document. One that was scanned or photographed does not: a JPEG cannot
 * hold transparency at all, so its background is solid whatever it looks like,
 * and stamped onto a page as it stands it covers whatever it is placed over.
 *
 * So every pixel brighter than the threshold is made fully transparent - the
 * paper - and everything darker is left exactly as it is - the ink. Brightness
 * is the plain average of red, green and blue, which is enough for ink on paper
 * and needs no explaining to whoever is moving the slider.
 *
 * A NEW array comes back and `data` is not touched, which is what lets the pad
 * run this again from the original image every time the slider moves. Running
 * it over its own output would eat the signature a little at a time.
 */
export function removeBackground(
  data: Uint8ClampedArray,
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data)

  for (let i = 0; i < out.length; i += 4) {
    const brightness = ((out[i] ?? 0) + (out[i + 1] ?? 0) + (out[i + 2] ?? 0)) / 3
    // Only ever made MORE transparent: a PNG that already had a transparent
    // background keeps it, whatever colour the empty pixels happen to be.
    if (brightness > threshold) out[i + 3] = 0
  }

  return out
}

/**
 * Where an image sits once it is scaled to fit a box and centred in it.
 *
 * One scale for both directions, so the signature keeps its shape: a signature
 * stretched to fill the pad is not that person's signature any more.
 */
export function fitCentred(
  source: { width: number; height: number },
  box: { width: number; height: number },
): InkBounds {
  if (source.width <= 0 || source.height <= 0) return { x: 0, y: 0, width: 0, height: 0 }

  const scale = Math.min(box.width / source.width, box.height / source.height)
  const width = source.width * scale
  const height = source.height * scale

  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}
