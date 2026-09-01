import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PERMISSIONS } from '@asps-dms/shared'
import { Alert } from '../components/ui/Alert.js'
import { ApiError } from '../lib/apiError.js'
import { useAuth } from '../features/auth/useAuth.js'
import { dashboardKeys, fetchDashboardSummary } from '../features/dashboard/api.js'

/**
 * The dashboard.
 *
 * Every number is counted against ACTIVE employees, in one query, so the tiles
 * cannot disagree with each other or with the employee list. What is chosen for
 * the top row is what somebody would act on this morning: who is outstanding,
 * what is overdue, and what is about to be.
 */

function Tile({
  label,
  value,
  tone = 'neutral',
  hint,
  to,
}: {
  label: string
  value: number
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  hint?: string
  to?: string
}) {
  const colour = {
    neutral: 'text-slate-900',
    good: 'text-status-verified',
    warn: 'text-status-pending',
    bad: 'text-status-rejected',
  }[tone]

  const body = (
    <>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${colour}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </>
  )

  const className =
    'block rounded-card border border-slate-200 bg-white p-4 shadow-sm' +
    (to ? ' transition hover:border-brand-600 hover:shadow' : '')

  return to ? (
    <Link to={to} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** A single bar, so the split is readable at a glance rather than as three numbers. */
function Split({
  parts,
}: {
  parts: { label: string; value: number; className: string }[]
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  if (total === 0) return null

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {parts.map((part) =>
          part.value > 0 ? (
            <div
              key={part.label}
              className={part.className}
              style={{ width: `${(part.value / total) * 100}%` }}
              title={`${part.label}: ${part.value}`}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((part) => (
          <li key={part.label} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span className={`inline-block h-2 w-2 rounded-full ${part.className}`} />
            {part.label}
            <span className="font-semibold text-slate-900">{part.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DashboardPage() {
  const { user, can } = useAuth()
  const canRead = can(PERMISSIONS.REPORT_READ)

  const summary = useQuery({
    queryKey: dashboardKeys.summary,
    queryFn: fetchDashboardSummary,
    enabled: canRead,
    staleTime: 60_000,
  })

  const first = user?.fullName.split(' ')[0]

  return (
    <main>
      <header>
        <h1 className="text-xl font-semibold text-slate-900">
          {first ? `Welcome, ${first}` : 'Dashboard'}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-800">{user?.username}</span> with the{' '}
          {user?.role} role.
        </p>
      </header>

      {!canRead ? (
        <p className="mt-6 text-sm text-slate-600">
          <Link to="/employees" className="font-medium text-brand-700 hover:text-brand-800">
            Open the employee list
          </Link>{' '}
          to get started.
        </p>
      ) : null}

      {summary.error ? (
        <div className="mt-6">
          <Alert
            title="Could not load the summary"
            referenceId={summary.error instanceof ApiError ? summary.error.referenceId : null}
          >
            {summary.error instanceof ApiError ? summary.error.message : 'Something went wrong.'}
          </Alert>
        </div>
      ) : null}

      {summary.isLoading ? (
        <p className="mt-6 text-sm text-slate-500" role="status">
          Loading the summary...
        </p>
      ) : null}

      {summary.data ? (
        <>
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Tile
                label="Overdue documents"
                value={summary.data.documents.overdue}
                tone={summary.data.documents.overdue > 0 ? 'bad' : 'good'}
                hint="Past their date and still not in"
                to="/employees"
              />
              <Tile
                label="Missing an ID card"
                value={summary.data.employeesMissingMandatory}
                tone={summary.data.employeesMissingMandatory > 0 ? 'bad' : 'good'}
                hint="Employees without Aadhaar or PAN"
                to="/employees"
              />
              <Tile
                label="Due in the next 7 days"
                value={summary.data.documents.dueSoon}
                tone={summary.data.documents.dueSoon > 0 ? 'warn' : 'good'}
              />
              <Tile
                label="Awaiting signature"
                value={summary.data.signatures.awaiting}
                tone={summary.data.signatures.awaiting > 0 ? 'warn' : 'good'}
                hint="Documents that still need signing"
              />
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-slate-900">Employees</h2>
            <div className="mt-2 grid gap-4 lg:grid-cols-3">
              <Tile
                label="On the books"
                value={summary.data.employees.total}
                hint={`${summary.data.employees.joinedLast30Days} joined in the last 30 days`}
                to="/employees"
              />
              <Tile
                label="Archived"
                value={summary.data.employees.archived}
                hint="Left, and not counted anywhere above"
              />
              <div className="rounded-card border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  By gender
                </p>
                <div className="mt-3">
                  <Split
                    parts={[
                      {
                        label: 'Men',
                        value: summary.data.employees.male,
                        className: 'bg-brand-600',
                      },
                      {
                        label: 'Women',
                        value: summary.data.employees.female,
                        className: 'bg-status-review',
                      },
                      {
                        label: 'Other',
                        value: summary.data.employees.other,
                        className: 'bg-status-verified',
                      },
                      {
                        // Shown rather than folded into a side. Guessing would
                        // put a number on the screen that somebody may act on.
                        label: 'Not recorded',
                        value: summary.data.employees.notRecorded,
                        className: 'bg-slate-300',
                      },
                    ]}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="On the checklists" value={summary.data.documents.total} />
              <Tile
                label="Received"
                value={summary.data.documents.received}
                tone="good"
                hint={`${summary.data.documents.verified} verified`}
              />
              <Tile
                label="Still to come"
                value={summary.data.documents.pending}
                tone={summary.data.documents.pending > 0 ? 'warn' : 'good'}
              />
              <Tile
                label="No signature on file"
                value={summary.data.signatures.employeesWithoutSignature}
                hint="Employees who cannot sign anything yet"
              />
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}
