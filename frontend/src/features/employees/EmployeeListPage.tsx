import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  EMPLOYEE_STATUS_FILTERS,
  MAX_FORMS_PER_PRINT,
  PERMISSIONS,
  type EmployeeListItem,
  type EmployeeSortKey,
  type JoinedWithinPeriod,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { IconButton } from '../../components/ui/IconButton.js'
import { PrintIcon } from '../../components/ui/icons.js'
import { Select } from '../../components/ui/Select.js'
import { TextField } from '../../components/ui/TextField.js'
import { useAuth } from '../auth/useAuth.js'
import { ApiError } from '../../lib/apiError.js'
import { saveBlob } from '../../lib/download.js'
import { formatDate } from '../../lib/format.js'
import { useDebounced } from '../../lib/useDebounced.js'
import {
  employeeKeys,
  fetchFacets,
  listEmployees,
  printEmployeeForm,
  printEmployeeForms,
} from './api.js'
import {
  ARCHIVED_CHOICE,
  activeFilterChips,
  archivedAreShown,
  employeeFiltersToSearch,
  employmentChoiceFilters,
  employmentChoiceOf,
  readEmployeeFilters,
  toEmployeeListQuery,
  type EmployeeFilters,
  type EmploymentChoice,
} from './listParams.js'

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

  /**
   * The filters live in the URL - see listParams.ts.
   *
   * This page is opened from the dashboard with filters already applied, and
   * two tiles in a row are the same component instance with a different search
   * string: held in state, the second tile clicked would change the address bar
   * and nothing else.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => readEmployeeFilters(searchParams), [searchParams])

  /**
   * The search box types locally.
   *
   * Deliberately NOT in the URL: a history entry per keystroke turns the Back
   * button into a re-run of everything somebody typed.
   */
  const [search, setSearch] = useState(filters.search)

  const update = (patch: Partial<EmployeeFilters>) => {
    // Any change to a filter invalidates the page number: page 4 of a search
    // that now returns 12 rows is an empty screen nobody asked for.
    setSearchParams(employeeFiltersToSearch({ ...filters, page: 1, ...patch }))
  }

  const { department, archivedOnly, joinedWithin, sortBy, sortDir, page } = filters

  /**
   * Which employees are ticked, by id.
   *
   * Ids rather than rows, and kept across pages: HR printing a department's
   * forms works through the list a page at a time, and a selection that emptied
   * itself on 'Next' would make that impossible. It is cleared when the FILTERS
   * change, because at that point the rows on screen are a different set of
   * people and a hidden selection is one somebody prints by accident.
   */
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  /** The row whose own print button is working, and the toolbar's. */
  const [printingId, setPrintingId] = useState<number | null>(null)
  const [printingSelection, setPrintingSelection] = useState(false)
  const [printError, setPrintError] = useState<ApiError | null>(null)

  const debouncedSearch = useDebounced(search)

  // A ticked row that scrolls out of the filter is a row somebody prints by
  // accident, so the selection is dropped whenever the set of people changes.
  useEffect(() => {
    setSelected(new Set())
  }, [searchParams, debouncedSearch])

  const params = { ...toEmployeeListQuery(filters, PAGE_SIZE), search: debouncedSearch || undefined }
  const chips = activeFilterChips(filters)

  const employees = useQuery({
    queryKey: employeeKeys.list(params),
    queryFn: () => listEmployees(params),
    // Without this the table empties on every keystroke and the page jumps;
    // keeping the previous rows while the next ones load is much steadier.
    placeholderData: keepPreviousData,
  })

  const facets = useQuery({ queryKey: employeeKeys.facets(), queryFn: fetchFacets })

  const rows = employees.data?.items ?? []
  const allOnPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.employeeId))
  const tooManySelected = selected.size > MAX_FORMS_PER_PRINT

  const toggleSelected = (employeeId: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(employeeId)) next.add(employeeId)
      return next
    })
  }

  /** The header tick box takes the whole page in or out, never other pages. */
  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current)
      for (const row of rows) {
        if (allOnPageSelected) next.delete(row.employeeId)
        else next.add(row.employeeId)
      }
      return next
    })
  }

  /**
   * Asks the server for the PDF and hands it to the browser.
   *
   * Both print buttons come through here, so a failure is reported the same way
   * whichever was pressed - on the screen, with the server's own words, rather
   * than as an error page saved into the downloads folder.
   */
  const print = async (
    load: () => Promise<{ blob: Blob; fileName: string }>,
    working: (busy: boolean) => void,
  ) => {
    working(true)
    setPrintError(null)
    try {
      const { blob, fileName } = await load()
      saveBlob(blob, fileName)
    } catch (caught) {
      setPrintError(caught instanceof ApiError ? caught : null)
    } finally {
      working(false)
    }
  }

  const printOne = (employeeId: number) =>
    void print(
      () => printEmployeeForm(employeeId),
      (busy) => setPrintingId(busy ? employeeId : null),
    )

  const printSelected = () =>
    void print(() => printEmployeeForms([...selected]), setPrintingSelection)

  const toggleSort = (key: EmployeeSortKey) => {
    if (sortBy === key) {
      update({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
      return
    }
    update({ sortBy: key, sortDir: 'asc' })
  }

  const data = employees.data
  const error = employees.error instanceof ApiError ? employees.error : null

  /**
   * The Print column.
   *
   * A row's print button produces that employee's FILE - their details and
   * every document they have sent in - so it needs the permission to take
   * documents away, and the column is not shown to somebody who has not got it.
   * The server refuses either way; this is so nobody is offered a button that
   * answers 403. 'Print selected' is a different paper, the checklist form, and
   * stays open to everybody who can read the list.
   */
  const canPrint = can(PERMISSIONS.DOCUMENT_DOWNLOAD)

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
        <div className="flex items-center gap-2">
          {/* The checklist form, one page per employee - not the documents. It
              needs only the read permission the list itself needs, so it stays
              offered to everybody who can see the page, a Viewer included. */}
          <Button
            variant="secondary"
            busy={printingSelection}
            busyLabel="Preparing..."
            disabled={selected.size === 0 || tooManySelected}
            onClick={printSelected}
          >
            {selected.size > 0 ? `Print selected (${selected.size})` : 'Print selected'}
          </Button>
          {can(PERMISSIONS.EMPLOYEE_CREATE) ? (
            <Link
              to="/employees/new"
              className="inline-flex items-center rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
            >
              Add employee
            </Link>
          ) : null}
        </div>
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
            onChange={(event) => update({ department: event.target.value })}
          />
        </div>

        <div className="min-w-44">
          <Select
            label="Joined"
            placeholder="Any time"
            value={joinedWithin}
            options={JOINED_WITHIN_CHOICES}
            onChange={(event) =>
              update({ joinedWithin: event.target.value as JoinedWithinPeriod | '' })
            }
          />
        </div>

        <div className="min-w-40">
          <Select
            label="Employment"
            // Not `status`: 'Archived' is archivedOnly, which is a different
            // question from whether somebody is still here. See listParams.ts.
            value={employmentChoiceOf(filters)}
            options={[
              { value: EMPLOYEE_STATUS_FILTERS.ACTIVE, label: 'Active' },
              { value: EMPLOYEE_STATUS_FILTERS.LEFT, label: 'Left' },
              { value: EMPLOYEE_STATUS_FILTERS.ALL, label: 'All' },
              { value: ARCHIVED_CHOICE, label: 'Archived' },
            ]}
            onChange={(event) =>
              update(employmentChoiceFilters(event.target.value as EmploymentChoice))
            }
          />
        </div>

        <label
          className={`flex items-center gap-2 py-2 text-sm ${
            archivedOnly ? 'text-slate-400' : 'text-slate-700'
          }`}
          // Said rather than left to be guessed: a checkbox that will not move
          // and does not say why reads as a broken page.
          title={
            archivedOnly
              ? 'Archived records are the only ones being listed'
              : 'List archived records alongside the rest'
          }
        >
          <input
            type="checkbox"
            checked={archivedAreShown(filters)}
            disabled={archivedOnly}
            onChange={(event) => update({ includeArchived: event.target.checked })}
            className="h-4 w-4 rounded border-slate-300 disabled:opacity-60"
          />
          Include archived
        </label>
      </section>

      {/* The filters a dashboard tile applied, which have no control of their
          own on this toolbar. Without them on the screen the list is simply
          short, and a short list with nothing explaining it reads as missing
          employees rather than as a filter. */}
      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs tracking-wide text-slate-500 uppercase">Filtered by</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => update(chip.clears)}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800 hover:bg-brand-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:outline-none"
              aria-label={`Remove the ${chip.label} filter`}
            >
              {chip.label}
              <span aria-hidden="true">&times;</span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Alert title="Could not load employees" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      {tooManySelected ? (
        <div className="mt-4">
          <Alert tone="info" title={`Too many to print at once (${selected.size} selected)`}>
            Up to {MAX_FORMS_PER_PRINT} forms can be printed in one file. Untick some rows, or
            print them in two goes.
          </Alert>
        </div>
      ) : null}

      {printError ? (
        <div className="mt-4">
          <Alert title="Could not print that" referenceId={printError.referenceId}>
            {printError.message}
          </Alert>
        </div>
      ) : null}

      <section className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th scope="col" className="w-10 px-4 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={allOnPageSelected}
                  // Ticked for some of the page, not all of it: the box says so
                  // rather than claiming the whole page is in.
                  ref={(node) => {
                    if (node) {
                      node.indeterminate =
                        !allOnPageSelected && rows.some((row) => selected.has(row.employeeId))
                    }
                  }}
                  onChange={togglePage}
                  aria-label="Select every employee on this page"
                  disabled={rows.length === 0}
                />
              </th>
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
              {canPrint ? (
                <th scope="col" className="px-4 py-2 font-medium">
                  Print
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.items.map((employee) => (
              <tr
                key={employee.employeeId}
                onClick={() => void navigate(`/employees/${employee.employeeId}`)}
                className="cursor-pointer hover:bg-slate-50"
              >
                {/* The whole row navigates, so anything inside it that is not
                    navigation has to stop the click before it gets there. */}
                <td className="px-4 py-2" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={selected.has(employee.employeeId)}
                    onChange={() => toggleSelected(employee.employeeId)}
                    aria-label={`Select ${employee.employeeName}`}
                  />
                </td>
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
                {canPrint ? (
                  <td className="px-4 py-2" onClick={(event) => event.stopPropagation()}>
                    <IconButton
                      label="Print employee form"
                      icon={<PrintIcon />}
                      busy={printingId === employee.employeeId}
                      onClick={() => printOne(employee.employeeId)}
                    />
                  </td>
                ) : null}
              </tr>
            ))}

            {data && data.items.length === 0 ? (
              <tr>
                <td
                  colSpan={canPrint ? 8 : 7}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  {debouncedSearch || department || chips.length > 0 || joinedWithin
                    ? 'No employee matches those filters.'
                    : 'No employees yet. Add the first one to start their document checklist.'}
                </td>
              </tr>
            ) : null}

            {!data && !error ? (
              <tr>
                <td
                  colSpan={canPrint ? 8 : 7}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
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
            onClick={() => update({ page: Math.max(1, page - 1) })}
          >
            Previous
          </Button>
          <span>
            Page {data.page} of {data.totalPages}
          </span>
          <Button
            variant="secondary"
            disabled={page >= data.totalPages}
            onClick={() => update({ page: page + 1 })}
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
 * Written as what is LEFT rather than as '7/10'. This column is read while
 * working down the Incomplete list, where the question is how many documents
 * are still to be collected from somebody - and a bare fraction leaves the
 * reader to do that subtraction on every row.
 *
 * Overdue is called out separately rather than folded into 'pending': a missing
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
        {counts.pending === 0
          ? 'All received'
          : `${counts.pending} of ${counts.total} pending`}
      </span>
      {counts.overdue > 0 ? <Badge tone="overdue">{counts.overdue} overdue</Badge> : null}
      {counts.signatureReviewRequired > 0 ? (
        <Badge tone="review">{counts.signatureReviewRequired} to sign</Badge>
      ) : null}
    </div>
  )
}
