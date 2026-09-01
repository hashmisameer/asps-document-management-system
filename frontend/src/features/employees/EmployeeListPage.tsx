import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  PERMISSIONS,
  type EmployeeListItem,
  type EmployeeSortKey,
  type JoinedWithinPeriod,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Select } from '../../components/ui/Select.js'
import { TextField } from '../../components/ui/TextField.js'
import { useAuth } from '../auth/useAuth.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDate } from '../../lib/format.js'
import { useDebounced } from '../../lib/useDebounced.js'
import { employeeKeys, fetchFacets, listEmployees, type EmployeeListParams } from './api.js'

/**
 * The joining-date periods, in the words the office uses.
 *
 * The values are the enum the API accepts; only the labels are for reading.
 */
const JOINED_WITHIN_CHOICES = [
  { value: 'week', label: 'Last week' },
  { value: 'month', label: 'Last month' },
  { value: 'sixMonths', label: 'Last 6 months' },
  { value: 'year', label: 'Last year' },
] as const

const PAGE_SIZE = 25

/**
 * The employee list.
 *
 * The filters are the API's filters: what the server validates with
 * employeeListQuerySchema is exactly what this page can ask for, so there is no
 * combination the UI offers that the API rejects.
 */
export function EmployeeListPage() {
  const { can } = useAuth()
  const navigate = useNavigate()

  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [joinedWithin, setJoinedWithin] = useState<JoinedWithinPeriod | ''>('')
  const [sortBy, setSortBy] = useState<EmployeeSortKey>('employeeName')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)

  const debouncedSearch = useDebounced(search)

  // Any change to the filters invalidates the page number: page 4 of a search
  // that now returns 12 rows is an empty screen the user did not ask for.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, department, includeArchived, joinedWithin, sortBy, sortDir])

  const params: EmployeeListParams = {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    sortDir,
    includeArchived,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(joinedWithin ? { joinedWithin } : {}),
    ...(department ? { department } : {}),
  }

  const employees = useQuery({
    queryKey: employeeKeys.list(params),
    queryFn: () => listEmployees(params),
    // Without this the table empties on every keystroke and the page jumps;
    // keeping the previous rows while the next ones load is much steadier.
    placeholderData: keepPreviousData,
  })

  const facets = useQuery({ queryKey: employeeKeys.facets(), queryFn: fetchFacets })

  const toggleSort = (key: EmployeeSortKey) => {
    if (sortBy === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortBy(key)
    setSortDir('asc')
  }

  const data = employees.data
  const error = employees.error instanceof ApiError ? employees.error : null

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Employees</h1>
          <p className="mt-1 text-sm text-slate-600">
            {data
              ? `${data.totalCount} ${data.totalCount === 1 ? 'employee' : 'employees'}`
              : 'Loading...'}
          </p>
        </div>
        {can(PERMISSIONS.EMPLOYEE_CREATE) ? (
          <Link
            to="/employees/new"
            className="inline-flex items-center rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            Add employee
          </Link>
        ) : null}
      </div>

      <section className="mt-4 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-64 flex-1">
          <TextField
            label="Search"
            type="search"
            placeholder="Name, code, department or designation"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="min-w-48">
          <Select
            label="Department"
            placeholder="All departments"
            value={department}
            options={(facets.data?.departments ?? []).map((value) => ({ value, label: value }))}
            onChange={(event) => setDepartment(event.target.value)}
          />
        </div>

        <div className="min-w-44">
          <Select
            label="Joined"
            placeholder="Any time"
            value={joinedWithin}
            options={JOINED_WITHIN_CHOICES}
            onChange={(event) => setJoinedWithin(event.target.value as JoinedWithinPeriod | '')}
          />
        </div>

        <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include archived
        </label>
      </section>

      {error ? (
        <div className="mt-4">
          <Alert title="Could not load employees" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      <section className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <SortableHeader
                label="Code"
                sortKey="employeeCode"
                active={sortBy}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Name"
                sortKey="employeeName"
                active={sortBy}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Joined"
                sortKey="joiningDate"
                active={sortBy}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Department"
                sortKey="department"
                active={sortBy}
                direction={sortDir}
                onSort={toggleSort}
              />
              <th scope="col" className="px-4 py-2 font-medium">
                Designation
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Documents
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.items.map((employee) => (
              <tr
                key={employee.employeeId}
                onClick={() => void navigate(`/employees/${employee.employeeId}`)}
                className="cursor-pointer hover:bg-slate-50"
              >
                <td className="px-4 py-2 font-mono text-xs text-slate-600">
                  {employee.employeeCode}
                </td>
                <td className="px-4 py-2">
                  {/* A real link, so the row is reachable by keyboard and opens
                      in a new tab the way any other link does. */}
                  <Link
                    to={`/employees/${employee.employeeId}`}
                    className="font-medium text-slate-900 hover:text-brand-700"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {employee.employeeName}
                  </Link>
                  {employee.isActive ? null : (
                    <span className="ml-2">
                      <Badge>Archived</Badge>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-700">{formatDate(employee.joiningDate)}</td>
                <td className="px-4 py-2 text-slate-700">{employee.department ?? '-'}</td>
                <td className="px-4 py-2 text-slate-700">{employee.designation ?? '-'}</td>
                <td className="px-4 py-2">
                  <DocumentSummary employee={employee} />
                </td>
              </tr>
            ))}

            {data && data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                  {debouncedSearch || department
                    ? 'No employee matches those filters.'
                    : 'No employees yet. Add the first one to start their document checklist.'}
                </td>
              </tr>
            ) : null}

            {!data && !error ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                  Loading employees...
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
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span>
            Page {data.page} of {data.totalPages}
          </span>
          <Button
            variant="secondary"
            disabled={page >= data.totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </main>
  )
}

function SortableHeader({
  label,
  sortKey,
  active,
  direction,
  onSort,
}: {
  label: string
  sortKey: EmployeeSortKey
  active: EmployeeSortKey
  direction: 'asc' | 'desc'
  onSort: (key: EmployeeSortKey) => void
}) {
  const isActive = active === sortKey
  return (
    <th
      scope="col"
      className="px-4 py-2 font-medium"
      aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase hover:text-slate-800"
      >
        {label}
        <span aria-hidden="true">{isActive ? (direction === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )
}

/**
 * How far through the checklist this employee is.
 *
 * Overdue is called out separately rather than folded into "pending": a missing
 * document that is still within its deadline is routine, and one that is past
 * it is the thing HR is looking for.
 */
function DocumentSummary({ employee }: { employee: EmployeeListItem }) {
  const { counts } = employee

  if (counts.total === 0) {
    return <span className="text-xs text-slate-500">No checklist</span>
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-700">
        {counts.completed}/{counts.total}
      </span>
      {counts.overdue > 0 ? <Badge tone="overdue">{counts.overdue} overdue</Badge> : null}
      {counts.signatureReviewRequired > 0 ? (
        <Badge tone="review">{counts.signatureReviewRequired} to sign</Badge>
      ) : null}
    </div>
  )
}
