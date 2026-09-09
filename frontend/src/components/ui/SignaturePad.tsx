import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { ALLOWED_SIGNATURE_MIME_TYPES, MAX_SIGNATURE_SIZE_BYTES } from '@asps-dms/shared'
import {
  DEFAULT_BACKGROUND_THRESHOLD,
  IMAGE_HEADER_BYTES,
  MAX_BACKGROUND_THRESHOLD,
  MIN_BACKGROUND_THRESHOLD,
  fitCentred,
  imageTypeOf,
  inkBounds,
  padBounds,
  removeBackground,
  strokeWidth,
} from '../../lib/signatureImage.js'

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
 *
 * A signature can also be UPLOADED, for the employee who is not standing at the
 * desk or who signed a form that came back by post. The uploaded image is drawn
 * onto this same canvas, its paper background is taken away, and it then leaves
 * by exactly the same road as ink does - cropped to itself, saved as a
 * transparent PNG. There is one output path, so there is one output format.
 */

export type SignatureMode = 'draw' | 'upload'

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
  /** Told which tab is showing, so a dialog can offer Undo only where it means something. */
  onModeChange?: (mode: SignatureMode) => void
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

/** What the file picker offers: 'image/png,image/jpeg'. */
const ACCEPT = ALLOWED_SIGNATURE_MIME_TYPES.join(',')
const MAX_MB = Math.floor(MAX_SIGNATURE_SIZE_BYTES / (1024 * 1024))

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ onInkChange, onModeChange, disabled = false }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const strokes = useRef<Point[][]>([])
    const current = useRef<Point[] | null>(null)
    // Device pixels per CSS pixel. At least 2, so the stored signature has
    // enough resolution to still look like ink when it is stamped onto an A4
    // page at print size rather than at the size it was drawn.
    const scale = useRef(2)

    const [mode, setMode] = useState<SignatureMode>('draw')
    /** The image as it was uploaded, kept so the slider can work from it again. */
    const uploaded = useRef<ImageBitmap | null>(null)
    const fileInput = useRef<HTMLInputElement>(null)
    const [hasUpload, setHasUpload] = useState(false)
    const [uploadError, setUploadError] = useState<string | null>(null)
    /** True when the threshold has taken the signature away along with the paper. */
    const [allRemoved, setAllRemoved] = useState(false)
    const [threshold, setThreshold] = useState(DEFAULT_BACKGROUND_THRESHOLD)
    // Read by a repaint that is not caused by the slider - a resize, say - which
    // must not make the ResizeObserver depend on a value that changes as it is
    // dragged.
    const thresholdRef = useRef(threshold)
    thresholdRef.current = threshold

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
     * Draws the uploaded image, without its paper, onto the same canvas.
     *
     * Always from the ORIGINAL image: the threshold is applied to a fresh copy
     * every time it moves, because applying it again to an image it has already
     * been applied to would eat the signature a slider-notch at a time.
     *
     * Everything here is in device pixels - the canvas as it really is - so
     * that what toPngBlob crops out matches what is on the screen.
     */
    const paintUpload = useCallback((level = thresholdRef.current): boolean => {
      const canvas = canvasRef.current
      const ctx = context()
      const image = uploaded.current
      if (!canvas || !ctx) return false

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!image) return false

      const box = fitCentred(image, { width: canvas.width, height: canvas.height })
      ctx.drawImage(image, box.x, box.y, box.width, box.height)

      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const cleaned = removeBackground(pixels.data, level)
      // Copied back into the buffer the canvas already gave us rather than
      // wrapped in a new ImageData: removeBackground stays a function that
      // returns a fresh array, and nothing here allocates a second one.
      pixels.data.set(cleaned)
      ctx.putImageData(pixels, 0, 0)

      // Whether anything survived, measured the same way the crop measures it.
      // A threshold set below the ink itself leaves a blank page, and being
      // told that here is better than a Save button that refuses.
      return inkBounds(cleaned, canvas.width, canvas.height) !== null
    }, [])

    /** Whichever of the two is showing. Used wherever the canvas has to be redrawn. */
    const repaint = useCallback(() => {
      if (uploaded.current) paintUpload()
      else redraw()
    }, [paintUpload, redraw])

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
      repaint()
    }, [repaint])

    useEffect(() => {
      resize()
      const observer = new ResizeObserver(resize)
      const canvas = canvasRef.current
      if (canvas) observer.observe(canvas)
      return () => observer.disconnect()
    }, [resize])

    /** Lets go of the uploaded image and leaves the canvas blank. */
    const clearUpload = useCallback(() => {
      uploaded.current?.close()
      uploaded.current = null
      setHasUpload(false)
      setUploadError(null)
      setAllRemoved(false)
      // Or choosing the same file again does nothing: the input's value has not
      // changed, so no change event is fired.
      if (fileInput.current) fileInput.current.value = ''
      redraw()
    }, [redraw])

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
      if (disabled || mode !== 'draw' || !event.isPrimary) return

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
      if (!stroke || !ctx || disabled || mode !== 'draw') return

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

    /**
     * The file somebody chose.
     *
     * Refused in three places, in this order: too big to be a signature, not
     * actually an image whatever it is called, and an image the browser cannot
     * decode. Each says which of the three it was, because 'that did not work'
     * leaves somebody trying the same file again.
     */
    const takeFile = async (file: File) => {
      setUploadError(null)

      if (file.size > MAX_SIGNATURE_SIZE_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1)
        setUploadError(`That image is ${mb} MB. A signature must be under ${MAX_MB} MB.`)
        return
      }

      const header = new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer())
      if (!imageTypeOf(header)) {
        setUploadError(
          'That file is not a PNG or a JPG. Renaming a file does not change what is inside it.',
        )
        return
      }

      let image: ImageBitmap
      try {
        // from-image, so a photograph taken with a phone held sideways arrives
        // the way up it was taken rather than the way up it was stored.
        image = await createImageBitmap(file, { imageOrientation: 'from-image' })
      } catch {
        setUploadError('That image could not be opened. Try scanning or exporting it again.')
        return
      }

      uploaded.current?.close()
      uploaded.current = image
      setHasUpload(true)

      const survived = paintUpload()
      setAllRemoved(!survived)
      onInkChange?.(survived)
    }

    const handleThreshold = (level: number) => {
      setThreshold(level)
      if (!uploaded.current) return

      const survived = paintUpload(level)
      setAllRemoved(!survived)
      onInkChange?.(survived)
    }

    /**
     * Moves between the two tabs, taking whatever was on the other one away.
     *
     * Only one signature is ever live. Somebody who draws, thinks better of it,
     * uploads a scan and saves must not have the two combined into one image -
     * and the pad is the only place that can be sure of it.
     */
    const switchTo = (next: SignatureMode) => {
      if (next === mode || disabled) return

      strokes.current = []
      current.current = null
      clearUpload()

      setMode(next)
      onModeChange?.(next)
      onInkChange?.(false)
    }

    useImperativeHandle(
      ref,
      (): SignaturePadHandle => ({
        clear: () => {
          strokes.current = []
          current.current = null
          if (uploaded.current) clearUpload()
          else redraw()
          onInkChange?.(false)
        },
        undo: () => {
          // Nothing to undo on an upload: it went on in one go and Clear takes
          // it off in one go.
          if (uploaded.current) return
          strokes.current.pop()
          current.current = null
          redraw()
          onInkChange?.(strokes.current.length > 0)
        },
        isEmpty: () => strokes.current.length === 0 && !uploaded.current,
        toPngBlob: async () => {
          const canvas = canvasRef.current
          const ctx = context()
          if (!canvas || !ctx) return null
          if (strokes.current.length === 0 && !uploaded.current) return null

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
          // An uploaded JPEG leaves here as a PNG for that reason - its paper
          // has just been made transparent and JPEG cannot carry that.
          return new Promise((resolve) => output.toBlob(resolve, 'image/png'))
        },
      }),
      [redraw, clearUpload, onInkChange],
    )

    const tabClass = (tab: SignatureMode): string =>
      `-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
        mode === tab
          ? 'border-brand-700 text-brand-800'
          : 'border-transparent text-slate-500 hover:text-slate-800'
      }`

    return (
      <div>
        <div className="mb-2 flex gap-1 border-b border-slate-200">
          <button type="button" className={tabClass('draw')} onClick={() => switchTo('draw')}>
            Draw
          </button>
          <button type="button" className={tabClass('upload')} onClick={() => switchTo('upload')}>
            Upload
          </button>
        </div>

        <div className="relative h-56 w-full rounded-md border border-slate-300 bg-white">
          {/* Behind the canvas, so none of it is ever part of the saved image. */}
          {mode === 'draw' ? (
            <>
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
            </>
          ) : null}

          {mode === 'upload' && !hasUpload ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400"
            >
              Choose a photograph or scan of the signature
            </div>
          ) : null}

          <canvas
            ref={canvasRef}
            // touch-none, or a finger or the pen drags the page instead of drawing.
            className="absolute inset-0 h-full w-full touch-none rounded-md"
            style={{
              cursor: disabled ? 'not-allowed' : mode === 'draw' ? 'crosshair' : 'default',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
        </div>

        {mode === 'upload' ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void takeFile(file)
                }}
                className="block flex-1 text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
              />
              <button
                type="button"
                onClick={clearUpload}
                disabled={disabled || !hasUpload}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Clear
              </button>
            </div>

            <div>
              <label className="flex items-center gap-3 text-xs text-slate-600">
                <span className="w-44 shrink-0">Background removal strength</span>
                <input
                  type="range"
                  min={MIN_BACKGROUND_THRESHOLD}
                  max={MAX_BACKGROUND_THRESHOLD}
                  value={threshold}
                  disabled={disabled || !hasUpload}
                  onChange={(event) => handleThreshold(Number(event.target.value))}
                  className="w-full"
                />
                <span className="w-8 text-right tabular-nums">{threshold}</span>
              </label>
              <p className="mt-1 text-xs text-slate-500">
                Higher takes away more of the paper. Lower keeps more of a faint signature.
              </p>
            </div>

            {uploadError ? <p className="text-xs text-red-700">{uploadError}</p> : null}

            {allRemoved && !uploadError ? (
              <p className="text-xs text-red-700">
                Nothing is left of the signature at this strength. Move the slider left.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  },
)
