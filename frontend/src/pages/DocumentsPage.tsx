import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  DOCUMENT_LIST_STATES,
  DOCUMENT_STATUS,
  deriveDeadline,
  type DocumentListState,
} from '@asps-dms/shared'
import { Alert } from '../components/ui/Alert.js'
import { Badge } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Select } from '../components/ui/Select.js'
import { ApiError } from '../lib/apiError.js'
import { formatDate } from '../lib/format.js'
import { employeeKeys, fetchFacets } from '../features/employees/api.js'
import {
  DOCUMENT_STATE_DESCRIPTION,
  DOCUMENT_STATE_LABEL,
  documentListKeys,
  listDocuments,
  type DocumentListItem,
} from '../features/documents/listApi.js'

/**
 * Every checklist row in the company: who owes what.
 *
 * This is what the dashboard's document tiles open, and the reason it exists at
 * all: those tiles count DOCUMENTS, not people. 'Still to come 57' is
 * fifty-seven documents spread over fewer employees than that, so sending
 * somebody to the employee list would show them a different number from the one
 * they clicked. Every line here names an employee AND a document.
 *
 * Read-only. A Viewer can open it, and there is nothing on it to press.
 *
 * The filters live in the URL, so a tile can open this page with one applied and
 * the list can be sent to somebody as a link.
 */

const PAGE_SIZE = 25

const STATE_CHOICES = DOCUMENT_LIST_STATES.map((value) => ({
  value,
  label: DOCUMENT_STATE_LABEL[value],
}))

function isState(value: string | null): value is DocumentListState {
  return value !== null && (DOCUMENT_LIST_STATES as readonly string[]).includes(value)
}

export function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const filters = useMemo(() => {
    const stateParam = searchParams.get('state')
    const page = Number(searchParams.get('page'))
    return {
      state: isState(stateParam) ? stateParam : ('all' as DocumentListState),
      department: searchParams.get('department') ?? '',
      page: Number.isInteger(page) && page > 0 ? page : 1,
    }
  }, [searchParams])

  const update = (patch: Partial<typeof filters>) => {
    const next = { ...filters, page: 1, ...patch }
    const params = new URLSearchParams()
    if (next.state !== 'all') params.set('state', next.state)
    if (next.department) params.set('department', next.department)
    if (next.page > 1) params.set('page', String(next.page))
    setSearchParams(params)
  }

  const params = {
    page: filters.page,
    pageSize: PAGE_SIZE,
    state: filters.state,
    ...(filters.department ? { department: filters.department } : {}),
  }

  const list = useQuery({
    queryKey: documentListKeys.list(params),
    queryFn: () => listDocuments(params),
    placeholderData: keepPreviousData,
  })

  const facets = useQuery({ queryKey: employeeKeys.facets(), queryFn: fetchFacets })

  const data = list.data
  const error = list.error instanceof ApiError ? list.error : null

  return (
    <main>
      {/* Most people arrive here from a dashboard tile, so the way back is the
          first thing on the page rather than only in the navigation. */}
      <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Dashboard
      </Link>

      <div className="mt-2">
        <h1 className="text-xl font-semibold text-slate-900">
          {DOCUMENT_STATE_LABEL[filters.state]}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {data ? `${data.totalCount} ${data.totalCount === 1 ? 'document' : 'documents'}` : 'Loading...'}
          {' · '}
          {DOCUMENT_STATE_DESCRIPTION[filters.state]}
        </p>
      </div>

      <section className="mt-4 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-56">
          <Select
            label="Show"
            value={filters.state}
            options={STATE_CHOICES}
            onChange={(event) => update({ state: event.target.value as DocumentListState })}
          />
        </div>

        <div className="min-w-48">
          <Select
            label="Department"
            placeholder="All departments"
            value={filters.department}
            options={(facets.data?.departments ?? []).map((value) => ({ value, label: value }))}
            onChange={(event) => update({ department: event.target.value })}
          />
        </div>
      </section>

      {error ? (
        <div className="mt-4">
          <Alert title="Could not load the documents" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      <section className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Employee
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Department
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Document
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Due
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Days
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">
            {data?.items.map((row) => (
              <tr key={row.documentId} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link
                    to={`/employees/${row.employeeId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {row.employeeName}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-slate-500">{row.employeeCode}</span>
                </td>
                <td className="px-4 py-2 text-slate-700">{row.department ?? '—'}</td>
                <td className="px-4 py-2 text-slate-700">
                  {row.documentName}
                  {row.isMandatory ? (
                    <span className="ml-2 text-xs text-slate-500">Mandatory</span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge row={row} />
                </td>
                <td className="px-4 py-2 text-slate-700">
                  {row.dueDate ? formatDate(row.dueDate) : '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                  <Days row={row} />
                </td>
              </tr>
            ))}

            {data && data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                  {/* Never a blank page: an empty list is an answer, and which
                      answer depends on what was asked. */}
                  {filters.state === 'overdue'
                    ? 'Nothing is overdue.'
                    : filters.state === 'dueSoon'
                      ? 'Nothing falls due in the next seven days.'
                      : filters.state === 'pending'
                        ? 'Every document has been received.'
                        : filters.department
                          ? 'No document matches those filters.'
                          : 'There are no documents on any checklist yet.'}
                </td>
              </tr>
            ) : null}

            {!data && !error ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                  Loading documents...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {data && data.totalPages > 1 ? (
        <nav
          aria-label="Pagination"
          className="mt-4 flex items-center justify-between text-sm text-slate-600"
        >
          <Button
            variant="secondary"
            disabled={filters.page <= 1}
            onClick={() => update({ page: Math.max(1, filters.page - 1) })}
          >
            Previous
          </Button>
          <span>
            Page {data.page} of {data.totalPages}
          </span>
          <Button
            variant="secondary"
            disabled={filters.page >= data.totalPages}
            onClick={() => update({ page: filters.page + 1 })}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </main>
  )
}

/**
 * What has happened to this document, in one word.
 *
 * 'Received' is a file having arrived, which is what the dashboard counts -
 * including one that was rejected, because it did arrive and somebody has to
 * deal with it. That case is called out rather than hidden inside 'Received'.
 */
function StatusBadge({ row }: { row: DocumentListItem }) {
  if (row.status === DOCUMENT_STATUS.REJECTED) {
    return <Badge tone="overdue">Rejected</Badge>
  }
  if (row.hasFile) {
    return (
      <Badge tone="verified">
        {row.status === DOCUMENT_STATUS.VERIFIED ? 'Verified' : 'Received'}
      </Badge>
    )
  }
  return row.deadlineState === 'Overdue' ? (
    <Badge tone="overdue">Overdue</Badge>
  ) : (
    <Badge tone="pending">Pending</Badge>
  )
}

/**
 * How long this row has been waiting, or has left.
 *
 * Read out of deriveDeadline rather than worked out here, so the confirmation
 * letter is counted in months on this screen exactly as it is on the
 * employee's own checklist - one document counted two ways is the sort of
 * difference nobody reports and everybody notices.
 */
function Days({ row }: { row: DocumentListItem }) {
  if (row.hasFile || row.daysRemaining === null) return <>—</>

  const { label } = deriveDeadline(row.dueDate, row.status, {
    deadlineUnit: row.deadlineUnit,
  })

  // The column heading already says what this is, so the sentence is trimmed
  // to its number: 'Due in 5 months' becomes '5 months'.
  return row.daysRemaining < 0 ? (
    <>{label.replace('Overdue by ', '')} overdue</>
  ) : (
    <>{label.replace('Due in ', '')}</>
  )
}
