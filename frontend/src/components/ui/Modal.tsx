import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  title: string
  /** Read out under the title, and the place to say what the dialog expects. */
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/**
 * A dialog.
 *
 * Rendered inline rather than through a portal: nothing in this application
 * puts a dialog inside a clipped or transformed container, so a portal would
 * buy nothing and cost the focus and unmount behaviour that comes free here.
 *
 * Escape closes it and focus moves into it when it opens, because a dialog that
 * traps neither is a dialog a keyboard user cannot leave or reach.
 */
export function Modal({ open, title, description, onClose, children, footer }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)

  /**
   * The current onClose, without it being a dependency of the effect below.
   *
   * Callers pass an inline arrow, so `onClose` is a different function on every
   * render of the parent. With it in the dependency array the effect re-ran on
   * each of those renders - and it calls `panel.current?.focus()`, which pulls
   * the caret out of whatever field is being typed in. Typing one letter in a
   * dialog's text box re-rendered the dialog, re-ran the effect, and moved focus
   * off the box; the second letter went nowhere.
   */
  const latestClose = useRef(onClose)
  latestClose.current = onClose

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latestClose.current()
    }
    document.addEventListener('keydown', onKeyDown)

    // Focus moves to the dialog when it OPENS, and not again while it is open.
    panel.current?.focus()

    // The page behind must not scroll while a dialog is over it.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Clicking away closes, but only the backdrop: a stray click inside the
          dialog must never discard a signature someone has just drawn. */}
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative w-full max-w-2xl rounded-card border border-slate-200 bg-white p-5 shadow-lg outline-none"
      >
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}

        <div className="mt-4">{children}</div>

        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  )
}
