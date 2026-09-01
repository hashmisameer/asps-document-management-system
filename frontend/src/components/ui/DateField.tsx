import { useId } from 'react'
import clsx from 'clsx'
import { formatDate } from '../../lib/format.js'

/**
 * A date field that says, in words, which date it is holding.
 *
 * The browser draws `<input type="date">` in ITS OWN locale. On a machine set
 * to English (United States) - the default on a new Windows install - a joining
 * date of 1 August 2026 is drawn as 08/01/2026, which anybody in India reads as
 * 8 January. Correcting that misreading by typing 01/08/2026 stores the 8th of
 * January, and nothing on screen contradicts it.
 *
 * That is not hypothetical. It happened to employee 00006016: the record was
 * created with 2026-08-01, edited to 2026-01-08, and the identity check then
 * correctly refused a service card printed 01/08/2026 - the check was right and
 * the record was wrong.
 *
 * So the value is echoed underneath in a form that cannot be read two ways:
 * '01 Aug 2026'. The picker still behaves as the browser wants; the person can
 * now see what it actually took.
 */
export function DateField({
  label,
  value,
  hint,
  error,
  onChange,
  ...rest
}: {
  label: string
  value: string
  hint?: string
  error?: string | undefined
  onChange: (event: { target: { value: string } }) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'value' | 'onChange'>) {
  const id = useId()
  const errorId = `${id}-error`
  const isComplete = /^\d{4}-\d{2}-\d{2}$/.test(value)

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        type="date"
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={clsx(
          'rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm',
          error ? 'border-status-rejected' : 'border-slate-300',
        )}
      />

      {isComplete ? (
        <p className="text-xs font-medium text-slate-700">
          {formatDate(value)}
          <span className="ml-1 font-normal text-slate-500">
            - check this is the date you meant
          </span>
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-xs text-status-rejected">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  )
}
