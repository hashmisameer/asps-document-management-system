import { useId, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  /** A server- or client-side validation message for this field. */
  error?: string | undefined
  hint?: string
}

/**
 * A labelled input.
 *
 * The label is a real <label> tied to the input, and an error is linked with
 * aria-describedby and aria-invalid rather than only coloured red. The app is
 * form-heavy and has to stay usable by keyboard and by screen reader.
 */
export function TextField({ label, error, hint, className, ...rest }: TextFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy.length > 0 ? describedBy : undefined}
        className={clsx(
          'rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm',
          'placeholder:text-slate-400',
          error ? 'border-status-rejected' : 'border-slate-300',
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-status-rejected">
          {error}
        </p>
      ) : null}
    </div>
  )
}
