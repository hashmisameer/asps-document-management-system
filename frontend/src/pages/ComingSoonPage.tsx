/**
 * A named placeholder.
 *
 * The navigation shows these entries so the shape of the application is visible
 * to whoever is reviewing it, and each one says plainly which milestone brings
 * it rather than pretending to be an empty page.
 */
export function ComingSoonPage({ title, milestone }: { title: string; milestone: string }) {
  return (
    <main>
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-600">Not built yet - planned for {milestone}.</p>
    </main>
  )
}
