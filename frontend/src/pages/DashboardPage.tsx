import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PERMISSIONS } from '@asps-dms/shared'
import { Alert } from '../components/ui/Alert.js'
import { ApiError } from '../lib/apiError.js'
import { useAuth } from '../features/auth/useAuth.js'
import { dashboardKeys, fetchDashboardSummary } from '../features/dashboard/api.js'
import {
  documentTiles,
  employeeTiles,
  genderSlices,
  needsAttentionTiles,
  type DashboardTile,
  type GenderSlice,
} from '../features/dashboard/tiles.js'

/**
 * The dashboard.
 *
 * Every number is counted against ACTIVE employees, in one query, so the tiles
 * cannot disagree with each other or with the lists they open. What is chosen
 * for the top row is what somebody would act on this morning: who is
 * outstanding, what is overdue, and what is about to be.
 *
 * EVERY TILE IS A LINK. A number nobody can open is a number nobody can act on -
 * it sends the reader to the employee list to work out for themselves which
 * five people it meant. What each tile opens, and with which filters, is in
 * features/dashboard/tiles.ts beside the value it shows.
 */

/** Focusable, hoverable, and obviously clickable - the same on every tile. */
const CARD =
  'block rounded-card border border-slate-200 bg-white p-4 shadow-sm cursor-pointer ' +
  'transition hover:border-brand-600 hover:bg-slate-50 hover:shadow ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ' +
  'focus-visible:ring-offset-2'

const TONE = {
  neutral: 'text-slate-900',
  good: 'text-status-verified',
  warn: 'text-status-pending',
  bad: 'text-status-rejected',
}

function Tile({ tile }: { tile: DashboardTile }) {
  return (
    <Link to={tile.to} className={CARD}>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{tile.label}</p>
      <p className={`mt-1 text-3xl font-semibold ${TONE[tile.tone]}`}>{tile.value}</p>
      {tile.hint ? <p className="mt-1 text-xs text-slate-500">{tile.hint}</p> : null}
    </Link>
  )
}

/**
 * The gender split: one bar, and a key whose entries are links.
 *
 * The count stays small beside the label, as it was - the bar is what is read at
 * a glance and the numbers are what is read when somebody leans in.
 */
function GenderSplit({ slices }: { slices: GenderSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)

  return (
    <div>
      {total > 0 ? (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
          {slices.map((slice) =>
            slice.value > 0 ? (
              <div
                key={slice.key}
                className={slice.className}
                style={{ width: `${(slice.value / total) * 100}%` }}
                title={`${slice.label}: ${slice.value}`}
              />
            ) : null,
          )}
        </div>
      ) : null}

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {slices.map((slice) => (
          <li key={slice.key}>
            <Link
              to={slice.to}
              className={
                'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-slate-600 ' +
                'hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none ' +
                'focus-visible:ring-2 focus-visible:ring-brand-600'
              }
            >
              <span className={`inline-block h-2 w-2 rounded-full ${slice.className}`} />
              {slice.label}
              <span className="font-semibold text-slate-900">{slice.value}</span>
            </Link>
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
              {needsAttentionTiles(summary.data).map((tile) => (
                <Tile key={tile.key} tile={tile} />
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-slate-900">Employees</h2>
            {/* Four across, with the split beneath them: Total reads first and
                the three it breaks into follow it. */}
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {employeeTiles(summary.data).map((tile) => (
                <Tile key={tile.key} tile={tile} />
              ))}
              <div className="rounded-card border border-slate-200 bg-white p-4 shadow-sm sm:col-span-2 lg:col-span-4">
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  By gender
                </p>
                <div className="mt-3">
                  <GenderSplit slices={genderSlices(summary.data)} />
                </div>
              </div>
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
            {/* Three, since 'No signature on file' moved into Needs attention as
                'Pending employee signature' - it was the same fact twice, and
                the copy in this section was the one nobody could act on. */}
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {documentTiles(summary.data).map((tile) => (
                <Tile key={tile.key} tile={tile} />
              ))}
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}
