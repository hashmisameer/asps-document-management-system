import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  EmployeeImportPreview,
  EmployeeImportResult,
  EmployeeImportRow,
  ImportDateFormat,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Select } from '../../components/ui/Select.js'
import { ApiError } from '../../lib/apiError.js'
import { downloadXlsx } from '../../lib/xlsx.js'
import { commitEmployeeImport, employeeKeys, previewEmployeeImport } from './api.js'

/**
 * Importing employees from a spreadsheet.
 *
 * Three columns, by position: the code, the name, the joining date - the same
 * three the Add Employee form requires. The heading row may say anything; what
 * was read is shown back, so a file with no heading row is obvious.
 *
 * PREVIEW FIRST. The file is judged and nothing is written until the person
 * has seen how many rows will be created, which will be skipped as already
 * there, which cannot be created and why, and every code whose leading zeros
 * were restored. Then the valid rows are created one at a time and the bad
 * ones are skipped: three wrong rows out of thirty do not stop the other
 * twenty-seven. The rejected rows can be downloaded, corrected and imported
 * straight back.
 */

/** The first date, in words: '07/09/2026' read as '7 September 2026', or the 9th of July. */
const IN_WORDS = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

function inWords(iso: string | null): string {
  if (!iso) return 'not a date'
  return IN_WORDS.format(new Date(`${iso}T00:00:00Z`))
}

const DATE_FORMAT_CHOICES: { value: ImportDateFormat; label: string }[] = [
  { value: 'dmy', label: 'Day / month / year (DD/MM/YYYY)' },
  { value: 'mdy', label: 'Month / day / year (MM/DD/YYYY) - old exports' },
]

export function ImportEmployeesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [dateFormat, setDateFormat] = useState<ImportDateFormat>('dmy')
  const [preview, setPreview] = useState<EmployeeImportPreview | null>(null)
  const [result, setResult] = useState<EmployeeImportResult | null>(null)

  const previewing = useMutation({
    mutationFn: (input: { file: File; dateFormat: ImportDateFormat }) =>
      previewEmployeeImport(input.file, input.dateFormat),
    onSuccess: setPreview,
  })

  const committing = useMutation({
    mutationFn: (input: { file: File; dateFormat: ImportDateFormat }) =>
      commitEmployeeImport(input.file, input.dateFormat),
    onSuccess: async (outcome) => {
      setResult(outcome)
      // The list behind this page is stale the moment anybody was created.
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
  })

  const choose = (chosen: File | null) => {
    setFile(chosen)
    setPreview(null)
    setResult(null)
    if (chosen) previewing.mutate({ file: chosen, dateFormat })
  }

  const changeFormat = (next: ImportDateFormat) => {
    setDateFormat(next)
    setPreview(null)
    setResult(null)
    if (file) previewing.mutate({ file, dateFormat: next })
  }

  const error = [previewing.error, committing.error].find((e) => e instanceof ApiError) as
    | ApiError
    | undefined

  /**
   * The rows that did not go in, as a file that can go straight back in.
   *
   * The cells exactly as they were, under the heading row as it was, plus one
   * column saying why. Codes are text cells, so the zeros the person restores
   * cannot be lost again on the way back.
   */
  const downloadRejected = (outcome: EmployeeImportResult, from: EmployeeImportPreview) => {
    type Rejected = { cells: string[]; reason: string }
    const rejected: Rejected[] = [
      ...outcome.failed.map((row) => ({ cells: row.cells, reason: row.errors.join('; ') })),
      ...outcome.refused.map((row) => ({ cells: row.cells, reason: row.reason })),
    ]
    const headings = [0, 1, 2].map((i) => from.header[i] || ['Employee code', 'Name', 'Joining date'][i] || '')
    downloadXlsx(
      `asps-dms-import-rejected-${new Date().toISOString().slice(0, 10)}.xlsx`,
      'Rejected rows',
      rejected,
      [
        { header: headings[0] ?? '', value: (r) => r.cells[0] ?? '', width: 14 },
        { header: headings[1] ?? '', value: (r) => r.cells[1] ?? '', width: 30 },
        { header: headings[2] ?? '', value: (r) => r.cells[2] ?? '', width: 14 },
        { header: 'Reason', value: (r) => r.reason, width: 70 },
      ],
    )
  }

  return (
    <main className="mx-auto w-full max-w-4xl">
      <Link to="/employees" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Employees
      </Link>

      <header className="mt-2">
        <h1 className="text-xl font-semibold text-slate-900">Import employees</h1>
        <p className="mt-1 text-sm text-slate-600">
          An .xlsx with three columns in this order: employee code, name, joining date. The
          heading row can say anything. Nothing is created until you confirm.
        </p>
      </header>

      <section className="mt-4 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
        <div>
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            {file ? 'Choose a different file' : 'Choose file'}
          </Button>
          {file ? <p className="mt-1 text-xs text-slate-500">{file.name}</p> : null}
        </div>

        <div className="min-w-72">
          <Select
            label="Dates in the file are written as"
            value={dateFormat}
            options={DATE_FORMAT_CHOICES}
            onChange={(event) => changeFormat(event.target.value as ImportDateFormat)}
          />
        </div>
      </section>

      {error ? (
        <div className="mt-4">
          <Alert title="That file could not be read" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      {previewing.isPending ? (
        <p className="mt-4 text-sm text-slate-500" role="status">
          Reading the file...
        </p>
      ) : null}

      {preview && !result ? (
        <PreviewPanel
          preview={preview}
          busy={committing.isPending}
          onConfirm={() => file && committing.mutate({ file, dateFormat })}
        />
      ) : null}

      {result && preview ? (
        <ResultPanel
          result={result}
          onDownloadRejected={() => downloadRejected(result, preview)}
          onDone={() => void navigate('/employees')}
        />
      ) : null}
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* The preview                                                                 */
/* -------------------------------------------------------------------------- */

function PreviewPanel({
  preview,
  busy,
  onConfirm,
}: {
  preview: EmployeeImportPreview
  busy: boolean
  onConfirm: () => void
}) {
  const { totals } = preview
  const problems = preview.rows.filter((row) => row.outcome !== 'create')
  const padded = preview.rows.filter((row) => row.paddedFrom !== undefined)
  const warned = preview.rows.filter((row) => row.outcome === 'create' && row.warnings.length > 0)

  return (
    <section className="mt-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">What was read</h2>

      {/* The heading and the first row, side by side: a file with no heading
          row shows an employee where the heading should be. */}
      <table className="mt-2 w-full text-left text-sm">
        <thead className="text-xs tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="py-1 pr-4 font-medium">Column</th>
            <th className="py-1 pr-4 font-medium">Heading in the file</th>
            <th className="py-1 font-medium">First row</th>
          </tr>
        </thead>
        <tbody>
          {['Employee code', 'Name', 'Joining date'].map((label, index) => (
            <tr key={label} className="border-t border-slate-100">
              <td className="py-1 pr-4 text-slate-700">{label}</td>
              <td className="py-1 pr-4 font-mono text-xs text-slate-600">
                {preview.header[index] || <span className="text-slate-400">(blank)</span>}
              </td>
              <td className="py-1 font-mono text-xs text-slate-600">
                {preview.firstRow[index] || <span className="text-slate-400">(blank)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview.firstDate ? (
        <p className="mt-3 text-sm text-slate-700">
          First joining date <span className="font-mono">{preview.firstDate.text}</span> read as{' '}
          <strong>{inWords(preview.firstDate.iso)}</strong>. If that is the wrong way round,
          change how dates are written above.
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Rows read" value={totals.read} />
        <Stat label="Will be created" value={totals.create} tone="text-status-verified" />
        <Stat label="Already there" value={totals.skip} />
        <Stat label="Cannot be created" value={totals.fail} tone={totals.fail ? 'text-status-rejected' : undefined} />
      </dl>

      {padded.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Leading zeros restored ({padded.length})
          </h3>
          <ul className="mt-1 text-sm text-slate-700">
            {padded.map((row) => (
              <li key={row.line} className="font-mono text-xs">
                line {row.line}: {row.paddedFrom} &rarr; {row.employeeCode}{' '}
                <span className="font-sans text-slate-500">(zeros restored)</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">Rows that will not be created</h3>
          <RowTable rows={problems} />
        </div>
      ) : null}

      {warned.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">Created with a detail left out</h3>
          <RowTable rows={warned} />
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button
          busy={busy}
          busyLabel="Creating..."
          disabled={totals.create === 0 || busy}
          onClick={onConfirm}
        >
          {totals.create > 0
            ? `Create ${totals.create} employee${totals.create === 1 ? '' : 's'}`
            : 'Nothing to create'}
        </Button>
        {totals.fail > 0 && totals.create > 0 ? (
          <span className="text-sm text-slate-600">
            The {totals.fail} that cannot be created will be skipped, not the whole file.
          </span>
        ) : null}
      </div>
    </section>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-card border border-slate-200 bg-slate-50 p-3">
      <dt className="text-xs tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold ${tone ?? 'text-slate-900'}`}>{value}</dd>
    </div>
  )
}

function RowTable({ rows }: { rows: EmployeeImportRow[] }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="py-1 pr-3 font-medium">Line</th>
            <th className="py-1 pr-3 font-medium">Code</th>
            <th className="py-1 pr-3 font-medium">Name</th>
            <th className="py-1 pr-3 font-medium">Outcome</th>
            <th className="py-1 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} className="border-t border-slate-100 align-top">
              <td className="py-1 pr-3 font-mono text-xs text-slate-600">{row.line}</td>
              <td className="py-1 pr-3 font-mono text-xs text-slate-600">
                {row.cells[0] || <span className="text-slate-400">(blank)</span>}
              </td>
              <td className="py-1 pr-3 text-slate-700">{row.cells[1] || '-'}</td>
              <td className="py-1 pr-3">
                <Badge
                  tone={
                    row.outcome === 'fail' ? 'rejected' : row.outcome === 'skip' ? 'neutral' : 'pending'
                  }
                >
                  {row.outcome === 'fail'
                    ? 'Cannot be created'
                    : row.outcome === 'skip'
                      ? 'Already there'
                      : 'Detail dropped'}
                </Badge>
              </td>
              <td className="py-1 text-slate-700">
                {row.outcome === 'skip'
                  ? `Already ${row.duplicate}`
                  : [...row.errors, ...row.warnings].join('; ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The result                                                                  */
/* -------------------------------------------------------------------------- */

function ResultPanel({
  result,
  onDownloadRejected,
  onDone,
}: {
  result: EmployeeImportResult
  onDownloadRejected: () => void
  onDone: () => void
}) {
  const rejected = result.failed.length + result.refused.length

  return (
    <section className="mt-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Done</h2>

      <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Created" value={result.created} tone="text-status-verified" />
        <Stat label="Already there" value={result.skipped} />
        <Stat label="Not created" value={rejected} tone={rejected ? 'text-status-rejected' : undefined} />
      </dl>

      <p className="mt-3 text-sm text-slate-600">
        Each employee created has the full document checklist, with deadlines from their joining
        date - exactly as if they had been added one at a time.
      </p>

      {result.refused.length > 0 ? (
        <div className="mt-3">
          <Alert tone="info" title={`${result.refused.length} refused by the database`}>
            These passed the preview and were still refused - usually a code somebody created by
            hand in the meantime. They are in the rejected file with the reason.
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {rejected > 0 ? (
          <Button variant="secondary" onClick={onDownloadRejected}>
            Download the {rejected} rejected row{rejected === 1 ? '' : 's'}
          </Button>
        ) : null}
        <Button onClick={onDone}>Back to employees</Button>
      </div>

      {rejected > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          Correct the rejected rows in that file and import it straight back - the reason column
          is ignored on the way in, and the rows already created are skipped.
        </p>
      ) : null}
    </section>
  )
}
