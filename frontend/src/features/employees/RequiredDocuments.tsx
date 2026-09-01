import { useQuery } from '@tanstack/react-query'
import { computeDueDate, type DocumentType } from '@asps-dms/shared'
import { Badge } from '../../components/ui/Badge.js'
import { toDisplayDate } from '../../lib/format.js'
import { documentTypeKeys, listDocumentTypes } from './api.js'

/**
 * The documents this employee will be asked for, listed while they are added.
 *
 * Creating an employee materialises one checklist row per active document type,
 * so this is not a preview of a decision anybody makes here - it is what is
 * about to happen.
 *
 * The MANDATORY ones must be attached before the record can be created. They
 * cannot be uploaded before it exists - there is no row to attach them to - so
 * the files are held here and sent the moment it does. An employee whose
 * identity documents were "going to be added later" is the record this rule
 * exists to prevent.
 *
 * Each date can be overridden. The default is computeDueDate, the same function
 * the server uses when it writes the deadline, so a row left alone gets exactly
 * the date it would have got anyway.
 */

export interface DueDateOverrides {
  [documentTypeId: number]: string
}

export interface SelectedFiles {
  [documentTypeId: number]: File
}

/** The types that must be attached before an employee can be created. */
export function missingMandatory(
  types: readonly DocumentType[] | undefined,
  files: SelectedFiles,
): DocumentType[] {
  return (types ?? []).filter((type) => type.isMandatory && !files[type.documentTypeId])
}

export function RequiredDocuments({
  joiningDate,
  dueText,
  onDueDateText,
  files,
  onFile,
  showMissing,
}: {
  joiningDate: string
  /** What is typed in each row, DD/MM/YYYY, keyed by document type. */
  dueText: Record<number, string>
  onDueDateText: (documentTypeId: number, text: string) => void
  files: SelectedFiles
  onFile: (documentTypeId: number, file: File | null) => void
  /** True once someone has tried to save, so a gap is called out rather than pre-empted. */
  showMissing: boolean
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

  const mandatory = types.data.filter((type) => type.isMandatory)

  return (
    <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">
        Documents to collect ({types.data.length})
      </h2>
      <p className="mt-1 text-xs text-slate-600">
        {mandatory.map((type) => type.documentName).join(' and ')} must be attached now. The rest
        can follow, and{' '}
        {validJoiningDate
          ? 'each date below is set from the joining date - change any of them if this employee was agreed something else.'
          : 'their dates fill in once a joining date is entered.'}
      </p>

      <ul className="mt-3 divide-y divide-slate-100">
        {types.data.map((type) => {
          const chosen = files[type.documentTypeId]
          const missing = showMissing && type.isMandatory && !chosen

          return (
            <li key={type.documentTypeId} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-slate-800">
                  {type.documentName}
                  {type.isMandatory ? (
                    <span className="ml-2 align-middle">
                      <Badge tone="pending">Required now</Badge>
                    </span>
                  ) : null}
                </span>

                <span className="flex items-center gap-2">
                  <Badge tone={chosen ? 'verified' : 'neutral'}>
                    {chosen ? 'Attached' : 'Pending'}
                  </Badge>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="DD/MM/YYYY"
                    aria-label={`Due date for ${type.documentName}`}
                    value={dueText[type.documentTypeId] ?? toDisplayDate(defaultFor(type))}
                    onChange={(event) => onDueDateText(type.documentTypeId, event.target.value)}
                    className="w-28 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800"
                  />
                </span>
              </div>

              {/* Only the mandatory ones are collected here. Offering a picker
                  against all ten would turn adding an employee into a filing
                  session, and the rest have deadlines precisely because they
                  arrive later. */}
              {type.isMandatory ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    aria-label={`${type.documentName} file`}
                    onChange={(event) =>
                      onFile(type.documentTypeId, event.target.files?.[0] ?? null)
                    }
                    className="text-xs text-slate-600 file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-xs file:text-slate-800"
                  />
                  {chosen ? (
                    <span className="truncate text-xs text-slate-500" title={chosen.name}>
                      {chosen.name}
                    </span>
                  ) : null}
                  {missing ? (
                    <span className="text-xs font-medium text-status-rejected">
                      {type.documentName} is required
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
