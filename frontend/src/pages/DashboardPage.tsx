import { Link } from 'react-router-dom'
import { useAuth } from '../features/auth/useAuth.js'

/**
 * The dashboard.
 *
 * Still without its tiles: the summary counts are a report, and reports arrive
 * in Milestone 5. What exists now is the way in to the employee records, which
 * is what anyone signing in is here for.
 */
export function DashboardPage() {
  const { user } = useAuth()

  return (
    <main>
      <h1 className="text-xl font-semibold text-slate-900">
        {user ? `Welcome, ${user.fullName.split(' ')[0]}` : 'Dashboard'}
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Signed in as <span className="font-medium text-slate-800">{user?.username}</span> with the{' '}
        {user?.role} role.
      </p>

      <section className="mt-6 rounded-card border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Employees</h2>
        <p className="mt-1 text-sm text-slate-600">
          Employee records and their document checklists are ready.{' '}
          <Link to="/employees" className="font-medium text-brand-700 hover:text-brand-800">
            Open the employee list
          </Link>
          .
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Documents can be uploaded, verified and rejected from an employee's page. Signature
          placement arrives in Milestone 5, and the summary tiles that belong on this page with the
          reports. Nothing here has run against a real database yet - see
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">
            docs/open-questions.md
          </code>
          item B1.
        </p>
      </section>
    </main>
  )
}
