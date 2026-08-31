import { useQuery } from '@tanstack/react-query'
import { computeDueDate } from '@asps-dms/shared'
import { Badge } from '../../components/ui/Badge.js'
import { formatDate } from '../../lib/format.js'
import { documentTypeKeys, listDocumentTypes } from './api.js'

/**
 * The documents this employee will be asked for, shown while they are added.
 *
 * Creating an employee materialises one checklist row per active document type,
 * so this list is not a preview of a decision anybody makes here - it is what is
 * about to happen. Showing it beforehand means the person filling the form knows
 * what they will be collecting, instead of finding out on the next screen.
 *
 * The dates are computed with computeDueDate, the same function the server uses
 * to set them. A second implementation would be a way for the promise made here
 * and the deadline stored a moment later to disagree.
 */
export function RequiredDocuments({ joiningDate }: { joiningDate: string }) {
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

  // A joining date that is not yet a real date - half typed, or not started -
  // gives no deadlines rather than nonsense ones.
  const validJoiningDate = /^\d{4}-\d{2}-\d{2}$/.test(joiningDate) ? joiningDate : null

  const mandatory = types.data.filter((type) => type.isMandatory).length

  return (
    <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">
        Documents to collect ({types.data.length})
      </h2>
      <p className="mt-1 text-xs text-slate-600">
        {mandatory === 0
          ? 'None of these is mandatory.'
          : `${mandatory} of them are mandatory. `}
        {validJoiningDate
          ? 'The dates below are set when the record is created.'
          : 'Enter a joining date to see when each one is due.'}
      </p>

      <ul className="mt-3 divide-y divide-slate-100">
        {types.data.map((type) => {
          const dueDate = validJoiningDate
            ? computeDueDate(validJoiningDate, type.deadlineValue, type.deadlineUnit)
            : null

          return (
            <li key={type.documentTypeId} className="flex items-baseline justify-between gap-3 py-2">
              <span className="text-sm text-slate-800">
                {type.documentName}
                {type.isMandatory ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="pending">Mandatory</Badge>
                  </span>
                ) : null}
              </span>

              <span className="shrink-0 text-xs text-slate-500">
                {dueDate
                  ? formatDate(dueDate)
                  : type.deadlineValue !== null
                    ? `${type.deadlineValue} ${type.deadlineUnit === 'MONTH' ? 'month' : 'day'}${
                        type.deadlineValue === 1 ? '' : 's'
                      } after joining`
                    : 'No deadline'}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
