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

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    panel.current?.focus()

    // The page behind must not scroll while a dialog is over it.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

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
