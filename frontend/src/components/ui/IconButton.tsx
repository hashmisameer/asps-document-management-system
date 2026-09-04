import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'

/**
 * An action shown as an icon.
 *
 * Three things this has to get right, because an icon on its own says nothing:
 *
 *   THE NAME IS ALWAYS THERE. `aria-label` carries it for a screen reader and
 *   `title` shows it on hover. A tooltip alone is a label only a sighted person
 *   with a mouse can read.
 *
 *   A DISABLED ACTION STAYS REACHABLE. The `disabled` attribute takes a button
 *   out of the tab order and stops it firing the events a tooltip needs, so
 *   somebody on a keyboard cannot find out why they cannot sign a document.
 *   `aria-disabled` says the same thing to assistive software while leaving the
 *   button focusable and hoverable; the click is refused in the handler.
 *
 *   THE NAME APPEARS ON SMALL SCREENS. Hover does not exist on a tablet, so
 *   below `lg` the label is drawn beside the icon rather than hidden behind a
 *   gesture nobody there can make.
 */
export interface IconActionProps {
  label: string
  icon: ReactNode
  /** Reads 'danger' for anything that takes something away. */
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** Shown instead of the icon while something is in flight. */
  busy?: boolean
}

const base =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md border px-1.5 text-sm transition-colors'

function classesFor(tone: 'default' | 'danger', disabled: boolean): string {
  return clsx(
    base,
    disabled
      ? 'cursor-not-allowed border-slate-200 bg-white text-slate-300'
      : tone === 'danger'
        ? 'border-slate-200 bg-white text-status-rejected hover:border-red-200 hover:bg-red-50'
        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900',
  )
}

/** The label, drawn only where hovering is not possible. */
function SmallScreenLabel({ label }: { label: string }) {
  return <span className="text-xs whitespace-nowrap lg:hidden">{label}</span>
}

export function IconButton({
  label,
  icon,
  tone = 'default',
  disabled = false,
  busy = false,
  onClick,
}: IconActionProps & { onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-disabled={disabled || busy}
      // Deliberately not the `disabled` attribute - see the note above.
      onClick={() => {
        if (disabled || busy) return
        onClick()
      }}
      className={classesFor(tone, disabled || busy)}
    >
      {busy ? <Spinner /> : icon}
      <SmallScreenLabel label={label} />
    </button>
  )
}

/** The same button, when the action is following a link. */
export function IconLink({
  label,
  icon,
  to,
  external = false,
  download = false,
}: Omit<IconActionProps, 'disabled' | 'busy'> & {
  to: string
  external?: boolean
  download?: boolean
}) {
  if (external) {
    return (
      <a
        href={to}
        title={label}
        aria-label={label}
        {...(download ? { download: '' } : { target: '_blank', rel: 'noreferrer' })}
        className={classesFor('default', false)}
      >
        {icon}
        <SmallScreenLabel label={label} />
      </a>
    )
  }

  return (
    <Link to={to} title={label} aria-label={label} className={classesFor('default', false)}>
      {icon}
      <SmallScreenLabel label={label} />
    </Link>
  )
}

/**
 * An empty slot where an action would be.
 *
 * Keeps every row's buttons in the same place. Dropping the button instead
 * would slide the rest along, so the eye has to find 'Remove' again on every
 * row and the column stops being scannable.
 */
export function IconSlot() {
  return <span aria-hidden="true" className="inline-block h-8 min-w-8 lg:min-w-8" />
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  )
}
