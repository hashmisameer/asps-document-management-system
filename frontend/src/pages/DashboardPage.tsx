import { useAuth } from '../features/auth/useAuth.js'

/**
 * The dashboard.
 *
 * A placeholder until the counts exist: the real tiles need employees and
 * documents, which arrive in Milestone 3, and the summary endpoint they read
 * cannot be written against a database that does not exist yet.
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
        <h2 className="text-sm font-semibold text-slate-900">Coming next</h2>
        <p className="mt-1 text-sm text-slate-600">
          Employee records, the document checklist and the deadline summary land in Milestone 3.
          They need a SQL Server 2014 instance before they can be built against anything real - see
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">
            docs/open-questions.md
          </code>
          item B1.
        </p>
      </section>
    </main>
  )
}
