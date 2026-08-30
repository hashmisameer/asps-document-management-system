import { DEADLINE_PRESETS, deriveDeadline, DOCUMENT_STATUS } from '@asps-dms/shared'

/**
 * Milestone 1 placeholder.
 *
 * Its only job is to prove the toolchain end to end: React + Vite + Tailwind
 * build, and - importantly - that the `@asps-dms/shared` workspace resolves and
 * runs in the browser bundle, so the same business rules drive both sides.
 *
 * Replaced by the real AppLayout and router in Milestone 2.
 */
export default function App() {
  const example = deriveDeadline('2026-09-11', DOCUMENT_STATUS.PENDING, { today: '2026-09-01' })

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-6 p-8">
      <header>
        <p className="text-sm font-medium tracking-wide text-brand-700 uppercase">
          ASPS International
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">
          Document Management System
        </h1>
      </header>

      <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Foundation check</h2>
        <p className="mt-1 text-sm text-slate-600">
          Shared business rules are resolving in the browser bundle.
        </p>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">
              Joining 2026-09-01, due in 10 days, as at 2026-09-01
            </dt>
            <dd className="font-medium text-slate-900">{example.label}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Configured deadline presets</dt>
            <dd className="font-medium text-slate-900">{DEADLINE_PRESETS.length}</dd>
          </div>
        </dl>
      </section>

      <p className="text-xs text-slate-500">
        Milestone 1 - foundation. Awaiting a SQL Server 2014 instance before the
        schema can be applied.
      </p>
    </main>
  )
}
