import { useId, type SelectHTMLAttributes } from 'react'
import clsx from 'clsx'

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string
  /** Rendered as the first option with an empty value. */
  placeholder?: string
  options: readonly { value: string; label: string }[]
  error?: string | undefined
}

/** A labelled select, matching TextField so a filter bar reads as one row. */
export function Select({ label, placeholder, options, error, className, ...rest }: SelectProps) {
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={clsx(
          'rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm',
          error ? 'border-status-rejected' : 'border-slate-300',
          className,
        )}
        {...rest}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} className="text-xs font-medium text-status-rejected">
          {error}
        </p>
      ) : null}
    </div>
  )
}
