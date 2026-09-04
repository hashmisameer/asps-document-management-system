import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { Alert } from '../components/ui/Alert.js'
import { Badge } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Select } from '../components/ui/Select.js'
import { ApiError } from '../lib/apiError.js'
import { downloadCsv, toCsv } from '../lib/csv.js'
import { saveBlob } from '../lib/download.js'
import { formatDate } from '../lib/format.js'
import { employeeKeys, fetchFacets } from '../features/employees/api.js'
import { documentTypeKeys, listDocumentTypes } from '../features/employees/api.js'
import {
  fetchEmployeesForDocumentType,
  printDocumentEmployeeList,
  reportKeys,
  type DocumentEmployeeFilters,
  type DocumentEmployeeRow,
  type DocumentEmployeeSortKey,
} from '../features/reports/api.js'

/**
 * Who still owes one particular document.
 *
 * Opened from a row of the by-document report, and it must agree with the
 * number on that row - so the server applies the same predicates and the count
 * shown here is the server's own total, not the length of the page.
 *
 * Paged rather than loaded whole. There are 568 employees; a screen that shows
 * twenty-five of them has no business asking for all of them.
 */

const PAGE_SIZE = 25

export function DocumentEmployeesPage() {
  const params = useParams<{ documentTypeId: string }>()
  const documentTypeId = Number(params.documentTypeId)

  // Outstanding by default: that is who anybody opens this list to chase.
  const [outstandingOnly, setOutstandingOnly] = useState(true)
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [department, setDepartment] = useState('')
  const [sortBy, setSortBy] = useState<DocumentEmployeeSortKey>('daysOverdue')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const filters: DocumentEmployeeFilters = {
    outstandingOnly,
    onlyOverdue,
    ...(department ? { department } : {}),
    sortBy,
    sortDir,
    page,
    pageSize: PAGE_SIZE,
  }

  const types = useQuery({
    queryKey: documentTypeKeys.all,
    queryFn: () => listDocumentTypes(),
    staleTime: 5 * 60 * 1000,
  })
  const facets = useQuery({ queryKey: employeeKeys.facets(), queryFn: fetchFacets })

  const list = useQuery({
    queryKey: reportKeys.documentEmployees(documentTypeId, filters),
    queryFn: () => fetchEmployeesForDocumentType(documentTypeId, filters),
    placeholderData: keepPreviousData,
  })

  /**
   * The list on paper.
   *
   * Sent the SAME filters and the same sort as the table, and no page number:
   * what comes back is every employee this list matches, in the order on
   * screen. Printing the visible page instead is the mistake this endpoint was
   * built to avoid - it quietly leaves people off a sheet somebody then chases
   * from.
   */
  const print = useMutation({
    mutationFn: () => printDocumentEmployeeList(documentTypeId, filters),
    onSuccess: ({ blob, fileName }) => saveBlob(blob, fileName),
  })

  const type = types.data?.find((t) => t.documentTypeId === documentTypeId)
  // A document nobody is obliged to send cannot be late. Its rows still list,
  // because the office asked to see them - they simply never read as overdue.
  const tracksOverdue = type?.isMandatory ?? true

  const error = list.error instanceof ApiError ? list.error : null
  const printError = print.error instanceof ApiError ? print.error : null
  const total = list.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const sortOn = (key: DocumentEmployeeSortKey) => {
    if (sortBy === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortDir('asc')
    }
    setPage(1)
  }

  /**
   * The list as it is on screen, as a spreadsheet.
   *
   * NO identity numbers and no pay. This file is emailed to a department head,
   * which puts it outside every control this system has - so it carries only
   * what somebody needs in order to go and ask for the document.
   */
  const exportRows = (rows: DocumentEmployeeRow[]) => {
    downloadCsv(
      `asps-dms-${(type?.documentName ?? 'document').toLowerCase().replace(/\s+/g, '-')}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
      toCsv(rows, [
        { header: 'Employee ID', value: (r) => r.employeeCode },
        { header: 'Name', value: (r) => r.employeeName },
        { header: 'Department', value: (r) => r.department ?? '' },
        { header: 'Designation', value: (r) => r.designation ?? '' },
        { header: 'Status', value: (r) => (tracksOverdue ? r.state : r.state === 'Received' ? 'Received' : 'Pending') },
        { header: 'Due', value: (r) => (r.dueDate ? formatDate(r.dueDate) : '') },
        {
          header: 'Days overdue',
          value: (r) => (tracksOverdue && r.daysOverdue !== null && r.daysOverdue > 0 ? r.daysOverdue : ''),
        },
      ]),
    )
  }

  return (
    <main>
      <Link to="/reports" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Reports
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {type?.documentName ?? 'Document'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {total} {total === 1 ? 'employee' : 'employees'}
            {outstandingOnly ? ' outstanding' : ''}
            {onlyOverdue ? ', overdue only' : ''}
          </p>
        </div>

        {/* Both, deliberately. The spreadsheet is what gets forwarded to a
            department head; the PDF is what gets carried round and ticked. */}
        {list.data && list.data.rows.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              busy={print.isPending}
              busyLabel="Preparing..."
              onClick={() => print.mutate()}
            >
              Print list
            </Button>
            <Button variant="secondary" onClick={() => exportRows(list.data.rows)}>
              Export CSV
            </Button>
          </div>
        ) : null}
      </div>

      <section className="mt-4 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-48">
          <Select
            label="Department"
            placeholder="All departments"
            value={department}
            options={(facets.data?.departments ?? []).map((value) => ({ value, label: value }))}
            onChange={(event) => {
              setDepartment(event.target.value)
              setPage(1)
            }}
          />
        </div>

        <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!outstandingOnly}
            onChange={(event) => {
              setOutstandingOnly(!event.target.checked)
              setPage(1)
            }}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include employees who have sent it
        </label>

        {tracksOverdue ? (
          <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={onlyOverdue}
              onChange={(event) => {
                setOnlyOverdue(event.target.checked)
                setPage(1)
              }}
              className="h-4 w-4 rounded border-slate-300"
            />
            Overdue only
          </label>
        ) : null}
      </section>

      {error ? (
        <div className="mt-4">
          <Alert title="Could not load that list" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      {printError ? (
        <div className="mt-4">
          <Alert title="Could not print that list" referenceId={printError.referenceId}>
            {printError.message}
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <SortableHeader label="Employee" sortKey="employeeName" active={sortBy} dir={sortDir} onSort={sortOn} />
              <SortableHeader label="Department" sortKey="department" active={sortBy} dir={sortDir} onSort={sortOn} />
              <SortableHeader label="Designation" sortKey="designation" active={sortBy} dir={sortDir} onSort={sortOn} />
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
              <SortableHeader label="Due" sortKey="dueDate" active={sortBy} dir={sortDir} onSort={sortOn} />
              {tracksOverdue ? (
                <SortableHeader
                  label="Days overdue"
                  sortKey="daysOverdue"
                  active={sortBy}
                  dir={sortDir}
                  onSort={sortOn}
                  align="right"
                />
              ) : null}
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">
            {list.data?.rows.map((row) => (
              <tr key={row.employeeId}>
                <td className="px-4 py-2">
                  {/* A new tab on purpose: HR goes to upload the document and
                      comes back to a list that has not lost its place. */}
                  <a
                    href={`/employees/${row.employeeId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {row.employeeName}
                  </a>
                  <span className="ml-2 font-mono text-xs text-slate-500">{row.employeeCode}</span>
                </td>
                <td className="px-4 py-2 text-slate-700">{row.department ?? '—'}</td>
                <td className="px-4 py-2 text-slate-700">{row.designation ?? '—'}</td>
                <td className="px-4 py-2">
                  <Badge
                    tone={
                      row.state === 'Received'
                        ? 'verified'
                        : row.state === 'Overdue' && tracksOverdue
                          ? 'overdue'
                          : 'pending'
                    }
                  >
                    {row.state === 'Overdue' && !tracksOverdue ? 'Pending' : row.state}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-slate-700">
                  {row.dueDate ? formatDate(row.dueDate) : '—'}
                </td>
                {tracksOverdue ? (
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                    {row.daysOverdue !== null && row.daysOverdue > 0 ? row.daysOverdue : '—'}
                  </td>
                ) : null}
              </tr>
            ))}

            {list.data && list.data.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                  Nobody matches these filters.
                </td>
              </tr>
            ) : null}

            {list.isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function SortableHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string
  sortKey: DocumentEmployeeSortKey
  active: DocumentEmployeeSortKey
  dir: 'asc' | 'desc'
  onSort: (key: DocumentEmployeeSortKey) => void
  align?: 'left' | 'right'
}) {
  const isActive = active === sortKey

  return (
    <th
      scope="col"
      className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase hover:text-slate-900"
      >
        {label}
        <span aria-hidden="true" className={isActive ? 'text-slate-900' : 'text-slate-300'}>
          {isActive && dir === 'desc' ? '▾' : '▴'}
        </span>
      </button>
    </th>
  )
}
