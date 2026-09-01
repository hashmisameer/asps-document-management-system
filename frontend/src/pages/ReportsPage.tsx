import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Alert } from '../components/ui/Alert.js'
import { Badge } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Select } from '../components/ui/Select.js'
import { ApiError } from '../lib/apiError.js'
import { downloadCsv, toCsv } from '../lib/csv.js'
import { formatDate } from '../lib/format.js'
import { fetchFacets, employeeKeys } from '../features/employees/api.js'
import {
  fetchByDocumentType,
  fetchOutstanding,
  reportKeys,
  type DocumentTypeReportRow,
  type OutstandingReportRow,
} from '../features/reports/api.js'

/**
 * Reports.
 *
 * Two questions, kept apart because different people ask them:
 *
 *   WHICH DOCUMENT is holding everyone up - a short table that says where to
 *   put the effort, read by whoever is planning the week.
 *
 *   WHO is outstanding - a long table naming the employee and the documents
 *   still to come from them, read by whoever is doing the chasing.
 *
 * Both download as CSV, built from the rows on screen rather than fetched
 * again, so the file is exactly what was being looked at.
 */

/** Today, for the filename, so two exports on different days are distinguishable. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function Bar({ received, expected }: { received: number; expected: number }) {
  const percent = expected === 0 ? 0 : Math.round((received / expected) * 100)
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
        <span
          className="block h-full bg-status-verified"
          style={{ width: `${percent}%` }}
          title={`${received} of ${expected}`}
        />
      </span>
      <span className="text-xs text-slate-500">{percent}%</span>
    </span>
  )
}

export function ReportsPage() {
  const [department, setDepartment] = useState('')
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [onlyMandatory, setOnlyMandatory] = useState(false)

  const facets = useQuery({ queryKey: employeeKeys.facets(), queryFn: fetchFacets })

  const byType = useQuery({
    queryKey: reportKeys.byDocumentType,
    queryFn: fetchByDocumentType,
  })

  const filters = {
    ...(department ? { department } : {}),
    ...(onlyOverdue ? { onlyOverdue } : {}),
    ...(onlyMandatory ? { onlyMandatory } : {}),
  }

  const outstanding = useQuery({
    queryKey: reportKeys.outstanding(filters),
    queryFn: () => fetchOutstanding(filters),
  })

  const exportByType = (rows: DocumentTypeReportRow[]) => {
    downloadCsv(
      `asps-dms-documents-${today()}.csv`,
      toCsv(rows, [
        { header: 'Document', value: (r) => r.documentName },
        { header: 'Mandatory', value: (r) => (r.isMandatory ? 'Yes' : 'No') },
        { header: 'Expected', value: (r) => r.expected },
        { header: 'Received', value: (r) => r.received },
        { header: 'Outstanding', value: (r) => r.outstanding },
        { header: 'Overdue', value: (r) => r.overdue },
      ]),
    )
  }

  const exportOutstanding = (rows: OutstandingReportRow[]) => {
    downloadCsv(
      `asps-dms-outstanding-${today()}.csv`,
      toCsv(rows, [
        { header: 'Employee ID', value: (r) => r.employeeCode },
        { header: 'Name', value: (r) => r.employeeName },
        { header: 'Department', value: (r) => r.department ?? '' },
        { header: 'Designation', value: (r) => r.designation ?? '' },
        { header: 'Joined', value: (r) => formatDate(r.joiningDate) },
        { header: 'Outstanding', value: (r) => r.outstanding },
        { header: 'Overdue', value: (r) => r.overdue },
        { header: 'Documents still to come', value: (r) => r.documents },
      ]),
    )
  }

  const failure = (error: unknown) =>
    error instanceof ApiError ? error.message : 'Something went wrong.'

  return (
    <main>
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Reports</h1>
        <p className="mt-1 text-sm text-slate-600">
          Counted against employees on the books. Archived employees are left out, so nothing here
          is a number that cannot be brought down.
        </p>
      </header>

      {/* Which document is holding everyone up. */}
      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">By document</h2>
          {byType.data && byType.data.length > 0 ? (
            <Button variant="secondary" onClick={() => exportByType(byType.data)}>
              Download CSV
            </Button>
          ) : null}
        </div>

        {byType.error ? (
          <div className="mt-2">
            <Alert title="Could not load this report">{failure(byType.error)}</Alert>
          </div>
        ) : null}

        <div className="mt-2 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2">Document</th>
                <th className="px-4 py-2">Received</th>
                <th className="px-4 py-2">Outstanding</th>
                <th className="px-4 py-2">Overdue</th>
                <th className="px-4 py-2">Progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byType.isLoading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    Loading...
                  </td>
                </tr>
              ) : null}

              {byType.data?.map((row) => (
                <tr key={row.documentTypeId}>
                  <td className="px-4 py-2">
                    <span className="font-medium text-slate-900">{row.documentName}</span>
                    {row.isMandatory ? (
                      <span className="ml-2 align-middle">
                        <Badge tone="pending">Mandatory</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {row.received} of {row.expected}
                  </td>
                  <td className="px-4 py-2 text-status-pending">{row.outstanding}</td>
                  <td className="px-4 py-2">
                    {row.overdue > 0 ? (
                      <span className="font-medium text-status-rejected">{row.overdue}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Bar received={row.received} expected={row.expected} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Who is outstanding, and what to ask them for. */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Outstanding by employee
            {outstanding.data ? (
              <span className="ml-2 font-normal text-slate-500">
                {outstanding.data.rows.length}
                {outstanding.data.truncated ? '+' : ''}
              </span>
            ) : null}
          </h2>
          {outstanding.data && outstanding.data.rows.length > 0 ? (
            <Button variant="secondary" onClick={() => exportOutstanding(outstanding.data.rows)}>
              Download CSV
            </Button>
          ) : null}
        </div>

        <section className="mt-2 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
          <div className="min-w-48">
            <Select
              label="Department"
              placeholder="All departments"
              value={department}
              options={(facets.data?.departments ?? []).map((value) => ({
                value,
                label: value,
              }))}
              onChange={(event) => setDepartment(event.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={onlyOverdue}
              onChange={(event) => setOnlyOverdue(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Overdue only
          </label>

          <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={onlyMandatory}
              onChange={(event) => setOnlyMandatory(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Aadhaar and PAN only
          </label>
        </section>

        {outstanding.error ? (
          <div className="mt-2">
            <Alert title="Could not load this report">{failure(outstanding.error)}</Alert>
          </div>
        ) : null}

        {outstanding.data?.truncated ? (
          <div className="mt-2">
            <Alert tone="info" title="Only the first 1000 employees are shown">
              Narrow it by department, or download the CSV of what is here.
            </Alert>
          </div>
        ) : null}

        <div className="mt-2 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2">Employee</th>
                <th className="px-4 py-2">Department</th>
                <th className="px-4 py-2">Joined</th>
                <th className="px-4 py-2">Outstanding</th>
                <th className="px-4 py-2">Overdue</th>
                <th className="px-4 py-2">Still to come</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {outstanding.isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    Loading...
                  </td>
                </tr>
              ) : null}

              {outstanding.data && outstanding.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    Nothing outstanding. Every employee matching these filters is up to date.
                  </td>
                </tr>
              ) : null}

              {outstanding.data?.rows.map((row) => (
                <tr key={row.employeeId}>
                  <td className="px-4 py-2">
                    <Link
                      to={`/employees/${row.employeeId}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {row.employeeName}
                    </Link>
                    <p className="font-mono text-xs text-slate-500">{row.employeeCode}</p>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{row.department ?? '-'}</td>
                  <td className="px-4 py-2 text-slate-700">{formatDate(row.joiningDate)}</td>
                  <td className="px-4 py-2 text-status-pending">{row.outstanding}</td>
                  <td className="px-4 py-2">
                    {row.overdue > 0 ? (
                      <span className="font-medium text-status-rejected">{row.overdue}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-2 text-xs text-slate-600">{row.documents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
