import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { inkBounds, padBounds, strokeWidth } from '../../lib/signatureImage.js'

/**
 * A pad to sign on.
 *
 * Written for a pen tablet - the XP-Pen Star G430S the office uses - but it is
 * only ever talking to the Pointer Events API, so the same component works with
 * a mouse, a touchscreen and any other tablet. That is deliberate: a pad that
 * needed the tablet vendor's SDK would need a bridge process on the Windows
 * machine to reach the browser at all, and would stop working the day the model
 * changes. With the XPPen driver installed the tablet is an ordinary Windows
 * pen device, so pointer events carry real pressure and nothing else is needed.
 *
 * The canvas holds INK AND NOTHING ELSE. The signing rule and its label are
 * drawn behind it in the DOM rather than onto it, because everything on this
 * canvas ends up in the stored image, and a signature with a printed line
 * through it would be stamped onto every document with that line.
 */

export interface SignaturePadHandle {
  clear: () => void
  /** Removes the last stroke. Signing is one attempt after another; undo is the point. */
  undo: () => void
  isEmpty: () => boolean
  /** The ink, cropped to itself, as a transparent PNG. Null if nothing was drawn. */
  toPngBlob: () => Promise<Blob | null>
}

interface SignaturePadProps {
  /** Told whenever the pad goes from empty to drawn on, or back. */
  onInkChange?: (hasInk: boolean) => void
  disabled?: boolean
}

interface Point {
  x: number
  y: number
  pressure: number
}

const INK = '#111827'
const MIN_WIDTH = 1.1
const MAX_WIDTH = 3.2
/** Transparent margin left around the ink when it is cropped, in CSS pixels. */
const CROP_MARGIN = 6

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ onInkChange, disabled = false }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const strokes = useRef<Point[][]>([])
    const current = useRef<Point[] | null>(null)
    // Device pixels per CSS pixel. At least 2, so the stored signature has
    // enough resolution to still look like ink when it is stamped onto an A4
    // page at print size rather than at the size it was drawn.
    const scale = useRef(2)

    const context = () => canvasRef.current?.getContext('2d') ?? null

    const drawSegment = useCallback((ctx: CanvasRenderingContext2D, from: Point, to: Point) => {
      ctx.beginPath()
      ctx.lineWidth = strokeWidth((from.pressure + to.pressure) / 2, MIN_WIDTH, MAX_WIDTH)
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }, [])

    /** Repaints every stroke. Used after an undo, and after a resize. */
    const redraw = useCallback(() => {
      const canvas = canvasRef.current
      const ctx = context()
      if (!canvas || !ctx) return

      ctx.setTransform(scale.current, 0, 0, scale.current, 0, 0)
      ctx.clearRect(0, 0, canvas.width / scale.current, canvas.height / scale.current)
      ctx.strokeStyle = INK
      ctx.fillStyle = INK
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (const stroke of strokes.current) {
        const only = stroke[0]
        // A dot: a pen put down and lifted without moving is still a mark.
        if (stroke.length === 1 && only) {
          ctx.beginPath()
          const radius = strokeWidth(only.pressure, MIN_WIDTH, MAX_WIDTH) / 2
          ctx.arc(only.x, only.y, radius, 0, Math.PI * 2)
          ctx.fill()
          continue
        }
        for (let i = 1; i < stroke.length; i += 1) {
          const from = stroke[i - 1]
          const to = stroke[i]
          if (from && to) drawSegment(ctx, from, to)
        }
      }
    }, [drawSegment])

    /**
     * Matches the backing store to the element's size.
     *
     * A canvas whose bitmap is its CSS size draws visibly soft ink on any
     * high-DPI screen, and the strokes are redrawn afterwards because resizing
     * a canvas clears it.
     */
    const resize = useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      scale.current = Math.max(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(rect.width * scale.current)
      canvas.height = Math.round(rect.height * scale.current)
      redraw()
    }, [redraw])

    useEffect(() => {
      resize()
      const observer = new ResizeObserver(resize)
      const canvas = canvasRef.current
      if (canvas) observer.observe(canvas)
      return () => observer.disconnect()
    }, [resize])

    const pointOf = (
      canvas: HTMLCanvasElement,
      event: { clientX: number; clientY: number; pressure: number },
    ): Point => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        pressure: event.pressure,
      }
    }

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled || !event.isPrimary) return

      // Capture, so a stroke that runs off the edge of the pad keeps drawing
      // until the pen is lifted instead of ending in the middle of a letter.
      event.currentTarget.setPointerCapture(event.pointerId)

      const wasEmpty = strokes.current.length === 0
      current.current = [pointOf(event.currentTarget, event.nativeEvent)]
      strokes.current.push(current.current)
      redraw()
      if (wasEmpty) onInkChange?.(true)
    }

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const stroke = current.current
      const ctx = context()
      if (!stroke || !ctx || disabled) return

      // The tablet reports far faster than the browser fires move events, and
      // the skipped positions are the difference between a smooth curve and a
      // chain of straight lines across a signature.
      const coalesced =
        typeof event.nativeEvent.getCoalescedEvents === 'function'
          ? event.nativeEvent.getCoalescedEvents()
          : []
      const samples = coalesced.length > 0 ? coalesced : [event.nativeEvent]

      for (const sample of samples) {
        const point = pointOf(event.currentTarget, sample)
        const previous = stroke[stroke.length - 1]
        stroke.push(point)
        if (previous) drawSegment(ctx, previous, point)
      }
    }

    const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!current.current) return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      current.current = null
    }

    useImperativeHandle(
      ref,
      (): SignaturePadHandle => ({
        clear: () => {
          strokes.current = []
          current.current = null
          redraw()
          onInkChange?.(false)
        },
        undo: () => {
          strokes.current.pop()
          current.current = null
          redraw()
          onInkChange?.(strokes.current.length > 0)
        },
        isEmpty: () => strokes.current.length === 0,
        toPngBlob: async () => {
          const canvas = canvasRef.current
          const ctx = context()
          if (!canvas || !ctx || strokes.current.length === 0) return null

          // Measured from the pixels rather than from the recorded points: what
          // is stored has to be what is visible, including the width the pen
          // pressure gave each stroke.
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const bounds = inkBounds(pixels.data, canvas.width, canvas.height)
          if (!bounds) return null

          const crop = padBounds(
            bounds,
            Math.round(CROP_MARGIN * scale.current),
            canvas.width,
            canvas.height,
          )

          const output = document.createElement('canvas')
          output.width = crop.width
          output.height = crop.height
          const outputCtx = output.getContext('2d')
          if (!outputCtx) return null

          outputCtx.drawImage(
            canvas,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            crop.width,
            crop.height,
          )

          // PNG, and never JPEG: the background stays transparent so the
          // signature sits on the document rather than in a white box over it.
          return new Promise((resolve) => output.toBlob(resolve, 'image/png'))
        },
      }),
      [redraw, onInkChange],
    )

    return (
      <div className="relative h-56 w-full rounded-md border border-slate-300 bg-white">
        {/* Behind the canvas, so none of it is ever part of the saved image. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 bottom-12 border-b border-dashed border-slate-300"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-6 left-8 text-xs text-slate-400"
        >
          Sign above the line
        </div>

        <canvas
          ref={canvasRef}
          // touch-none, or a finger or the pen drags the page instead of drawing.
          className="absolute inset-0 h-full w-full touch-none rounded-md"
          style={{ cursor: disabled ? 'not-allowed' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
    )
  },
)
