import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PERMISSIONS, type EmployeeProfile } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { DocumentChecklist } from '../documents/DocumentChecklist.js'
import { SignatureCard } from '../signatures/SignatureCard.js'
import { PhotoCard } from './PhotoCard.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDate } from '../../lib/format.js'
import {
  employeeKeys,
  fetchEmployee,
  fetchEmployeeDocuments,
  setEmployeeArchived,
} from './api.js'

/**
 * One employee: their details, their checklist progress, and every document
 * the checklist expects of them.
 *
 * Uploading, verifying and signing those documents arrive in Milestone 4; this
 * page already shows what is outstanding, because that is the question the
 * record exists to answer.
 */
export function EmployeeDetailPage() {
  const params = useParams<{ employeeId: string }>()
  const employeeId = Number(params.employeeId)
  const { can } = useAuth()
  const queryClient = useQueryClient()

  const employee = useQuery({
    queryKey: employeeKeys.detail(employeeId),
    queryFn: () => fetchEmployee(employeeId),
  })

  const documents = useQuery({
    queryKey: employeeKeys.documents(employeeId),
    queryFn: () => fetchEmployeeDocuments(employeeId),
  })

  const archive = useMutation({
    mutationFn: (archived: boolean) => setEmployeeArchived(employeeId, archived),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
  })

  if (employee.isLoading) {
    return (
      <main className="p-2 text-sm text-slate-500" role="status">
        Loading employee...
      </main>
    )
  }

  if (employee.error || !employee.data) {
    const error = employee.error instanceof ApiError ? employee.error : null
    return (
      <main>
        <Alert title="Could not load that employee" referenceId={error?.referenceId}>
          {error?.message ?? 'Something went wrong.'}
        </Alert>
        <Link to="/employees" className="mt-3 inline-block text-sm text-brand-700">
          Back to employees
        </Link>
      </main>
    )
  }

  const profile = employee.data
  const archiveError = archive.error instanceof ApiError ? archive.error : null

  return (
    <main>
      <Link to="/employees" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Employees
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold text-slate-900">
            {profile.employeeName}
            {profile.isActive ? null : <Badge>Archived</Badge>}
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{profile.employeeCode}</p>
        </div>

        <div className="flex items-center gap-2">
          {can(PERMISSIONS.EMPLOYEE_UPDATE) ? (
            <Link
              to={`/employees/${employeeId}/edit`}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Edit
            </Link>
          ) : null}
          {can(PERMISSIONS.EMPLOYEE_ARCHIVE) ? (
            <Button
              variant="secondary"
              busy={archive.isPending}
              busyLabel="Working..."
              onClick={() => archive.mutate(profile.isActive)}
            >
              {profile.isActive ? 'Archive' : 'Restore'}
            </Button>
          ) : null}
        </div>
      </div>

      {archiveError ? (
        <div className="mt-3">
          <Alert title="Could not change that" referenceId={archiveError.referenceId}>
            {archiveError.message}
          </Alert>
        </div>
      ) : null}

      {profile.isActive ? null : (
        <div className="mt-3">
          <Alert tone="info" title="This employee is archived">
            Their record and documents are kept, and they are hidden from the employee list until
            they are restored.
          </Alert>
        </div>
      )}

      <div className="mt-4">
        <PhotoCard employee={profile} />
      </div>
      <Details profile={profile} />
      <Counts profile={profile} />
      {/* The employee's own signature, and nothing else. The authoriser's is the
          signed-in user's, the same on every record, and putting it here read as
          though it belonged to this employee. It lives in the account menu. */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold text-slate-900">Signature</h2>
        <div className="mt-2">
          <SignatureCard employeeId={employeeId} employeeName={profile.employeeName} />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-slate-900">Document checklist</h2>

        {documents.error ? (
          <div className="mt-2">
            <Alert title="Could not load the checklist">
              {documents.error instanceof ApiError
                ? documents.error.message
                : 'Something went wrong.'}
            </Alert>
          </div>
        ) : null}

        <div className="mt-2">
          <DocumentChecklist documents={documents.data} isLoading={documents.isLoading} />
        </div>
      </section>
    </main>
  )
}

function Details({ profile }: { profile: EmployeeProfile }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Joining date', value: formatDate(profile.joiningDate) },
    { label: 'Department', value: profile.department ?? '-' },
    { label: 'Designation', value: profile.designation ?? '-' },
    { label: 'Signature on file', value: profile.hasSignature ? 'Yes' : 'Not uploaded' },
  ]

  return (
    <dl className="mt-4 grid grid-cols-2 gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-4">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs tracking-wide text-slate-500 uppercase">{row.label}</dt>
          <dd className="mt-1 text-sm text-slate-900">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Counts({ profile }: { profile: EmployeeProfile }) {
  const { counts } = profile
  const tiles = [
    { label: 'Documents', value: counts.total, tone: 'text-slate-900' },
    { label: 'Received', value: counts.completed, tone: 'text-status-verified' },
    { label: 'Outstanding', value: counts.pending, tone: 'text-status-pending' },
    { label: 'Overdue', value: counts.overdue, tone: 'text-status-overdue' },
  ]

  return (
    <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-card border border-slate-200 bg-white p-4 shadow-sm"
        >
          <p className="text-xs tracking-wide text-slate-500 uppercase">{tile.label}</p>
          <p className={`mt-1 text-2xl font-semibold ${tile.tone}`}>{tile.value}</p>
        </div>
      ))}
    </div>
  )
}
