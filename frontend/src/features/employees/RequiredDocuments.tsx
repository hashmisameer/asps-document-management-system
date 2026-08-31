import { useQuery } from '@tanstack/react-query'
import { computeDueDate, type DocumentType } from '@asps-dms/shared'
import { Badge } from '../../components/ui/Badge.js'
import { documentTypeKeys, listDocumentTypes } from './api.js'

/**
 * The documents this employee will be asked for, listed while they are added.
 *
 * Creating an employee materialises one checklist row per active document type,
 * so this is not a preview of a decision anybody makes here - it is what is
 * about to happen. Showing it beforehand means the person filling the form
 * knows what they will be collecting rather than finding out on the next screen.
 *
 * Each date can be overridden. The default is computeDueDate, the same function
 * the server uses when it writes the deadline, so a row left alone gets exactly
 * the date it would have got anyway. A row that is changed is applied as a
 * deliberate deadline override once the employee exists - there is nothing to
 * override before that, because the document row does not exist yet.
 */

export interface DueDateOverrides {
  [documentTypeId: number]: string
}

export function RequiredDocuments({
  joiningDate,
  overrides,
  onOverride,
}: {
  joiningDate: string
  overrides: DueDateOverrides
  onOverride: (documentTypeId: number, dueDate: string) => void
}) {
  const types = useQuery({
    queryKey: documentTypeKeys.all,
    queryFn: listDocumentTypes,
    staleTime: 5 * 60 * 1000,
  })

  if (types.isLoading) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading the document list...
      </p>
    )
  }

  if (!types.data || types.data.length === 0) return null

  // A half-typed date gives no deadlines rather than nonsense ones.
  const validJoiningDate = /^\d{4}-\d{2}-\d{2}$/.test(joiningDate) ? joiningDate : null

  const defaultFor = (type: DocumentType): string =>
    (validJoiningDate
      ? computeDueDate(validJoiningDate, type.deadlineValue, type.deadlineUnit)
      : null) ?? ''

  const mandatory = types.data.filter((type) => type.isMandatory).length

  return (
    <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">
        Documents to collect ({types.data.length})
      </h2>
      <p className="mt-1 text-xs text-slate-600">
        {mandatory} of them are mandatory.{' '}
        {validJoiningDate
          ? 'Each date is set from the joining date; change any of them if this employee was agreed something else.'
          : 'Enter a joining date to fill in the dates, or set them by hand.'}
      </p>

      <ul className="mt-3 divide-y divide-slate-100">
        {types.data.map((type) => (
          <li
            key={type.documentTypeId}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span className="text-sm text-slate-800">
              {type.documentName}
              {type.isMandatory ? (
                <span className="ml-2 align-middle">
                  <Badge tone="pending">Mandatory</Badge>
                </span>
              ) : null}
            </span>

            <span className="flex items-center gap-2">
              <Badge tone="neutral">Pending</Badge>
              <input
                type="date"
                aria-label={`Due date for ${type.documentName}`}
                value={overrides[type.documentTypeId] ?? defaultFor(type)}
                onChange={(event) => onOverride(type.documentTypeId, event.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800"
              />
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-slate-500">
        Files are uploaded on the next step, once the record exists.
      </p>
    </section>
  )
}
