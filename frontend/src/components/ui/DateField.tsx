import { useEffect, useId, useState } from 'react'
import clsx from 'clsx'
import { parseDisplayDate, toDisplayDate } from '../../lib/format.js'

/**
 * A date typed and shown as DD/MM/YYYY, the way the company writes it.
 *
 * NOT `<input type="date">`. The browser draws that in ITS OWN locale, and on a
 * machine set to English (United States) - the default on a new Windows install
 * - 1 August 2026 appears as 08/01/2026, which anybody here reads as 8 January.
 *
 * That is not hypothetical. Employee 00006016 was created with 2026-08-01 and
 * edited to 2026-01-08, and the identity check then correctly refused a service
 * card printed 01/08/2026: the check was right and the record was wrong. The
 * audit trail shows the swap happening in a single edit.
 *
 * So the field is plain text with one fixed order. What is typed is what is
 * meant, on every machine, whatever its locale is set to.
 *
 * The ISO value is still what leaves this component - it is what the API and
 * the database use - and it is only converted at the edge, here, where a person
 * is looking.
 */
export function DateField({
  label,
  value,
  hint,
  error,
  onChange,
  ...rest
}: {
  /** ISO 'YYYY-MM-DD', or '' when there is nothing yet. */
  label: string
  value: string
  hint?: string
  error?: string | undefined
  onChange: (event: { target: { value: string } }) => void
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'value' | 'onChange' | 'placeholder'
>) {
  const id = useId()
  const errorId = `${id}-error`

  // What is being typed, which is not always a date yet: '01/0' is on the way
  // to one. Held separately so a half-typed value is not thrown away by a
  // re-render, or turned into something else on its way through the parser.
  const [text, setText] = useState(() => toDisplayDate(value))

  useEffect(() => {
    // Follow the value when it changes from outside - loading an employee to
    // edit - without fighting the person typing into it.
    const asDisplay = toDisplayDate(value)
    setText((current) => (parseDisplayDate(current) === value ? current : asDisplay))
  }, [value])

  const handle = (next: string) => {
    setText(next)
    const iso = parseDisplayDate(next)
    // Empty clears the date; anything unparseable is left alone until it is
    // finished, rather than reported as wrong on the second keystroke.
    if (iso) onChange({ target: { value: iso } })
    else if (next.trim() === '') onChange({ target: { value: '' } })
  }

  const unparseable = text.trim() !== '' && parseDisplayDate(text) === null

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        onChange={(event) => handle(event.target.value)}
        aria-invalid={error || unparseable ? true : undefined}
        aria-describedby={error || unparseable ? errorId : undefined}
        className={clsx(
          'rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm',
          error || unparseable ? 'border-status-rejected' : 'border-slate-300',
        )}
      />

      {error ? (
        <p id={errorId} className="text-xs text-status-rejected">
          {error}
        </p>
      ) : unparseable ? (
        <p id={errorId} className="text-xs text-status-rejected">
          Write the date as DD/MM/YYYY, for example 01/08/2026.
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  )
}
