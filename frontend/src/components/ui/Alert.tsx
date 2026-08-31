import type { ReactNode } from 'react'
import clsx from 'clsx'

interface AlertProps {
  tone?: 'error' | 'info'
  title?: string
  children: ReactNode
  /** Shown small and monospaced: it matches a line in the server log. */
  referenceId?: string | null
}

/**
 * A message the user has to read.
 *
 * role="alert" so it is announced when it appears - a sign-in failure that is
 * only visible is a sign-in failure a screen reader user never hears about.
 */
export function Alert({ tone = 'error', title, children, referenceId }: AlertProps) {
  return (
    <div
      role="alert"
      className={clsx(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'error'
          ? 'border-red-200 bg-red-50 text-status-rejected'
          : 'border-brand-200 bg-brand-50 text-brand-800',
      )}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? 'mt-0.5' : undefined}>{children}</div>
      {referenceId ? (
        <p className="mt-1 font-mono text-xs opacity-80">Reference: {referenceId}</p>
      ) : null}
    </div>
  )
}
