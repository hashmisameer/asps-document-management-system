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
