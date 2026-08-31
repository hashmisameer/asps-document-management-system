import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEADLINE_STATE,
  DEADLINE_STATE_LABEL,
  DOCUMENT_STATUS_LABEL,
  PERMISSIONS,
  SIGNATURE_STATUS,
  SIGNATURE_STATUS_LABEL,
  deriveDeadline,
  type EmployeeDocument,
  type EmployeeProfile,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import {
  Badge,
  DEADLINE_STATE_TONE,
  DOCUMENT_STATUS_TONE,
} from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
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

      <Details profile={profile} />
      <Counts profile={profile} />

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

        <div className="mt-2 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Document
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Due
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Signature
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documents.data?.map((document) => (
                <ChecklistRow key={document.documentId} item={document} />
              ))}

              {documents.data && documents.data.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                    No document types are configured yet, so this employee has no checklist. Seed
                    them from the official company document list.
                  </td>
                </tr>
              ) : null}

              {documents.isLoading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                    Loading checklist...
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
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

function ChecklistRow({ item }: { item: EmployeeDocument }) {
  // The label is recomputed from the same shared rule the server used, so an
  // overdue item that crosses midnight while the page is open says so
  // without waiting for a refetch.
  const deadline = deriveDeadline(item.dueDate, item.status)

  return (
    <tr>
      <td className="px-4 py-2">
        <span className="font-medium text-slate-900">{item.documentName}</span>
        {item.isMandatory ? (
          <span className="ml-2 text-xs text-slate-500">Mandatory</span>
        ) : null}
      </td>
      <td className="px-4 py-2">
        <Badge tone={DOCUMENT_STATUS_TONE[item.status]}>
          {DOCUMENT_STATUS_LABEL[item.status]}
        </Badge>
      </td>
      <td className="px-4 py-2">
        {item.dueDate ? (
          <div className="flex items-center gap-2">
            <span className="text-slate-700">{formatDate(item.dueDate)}</span>
            {deadline.state === DEADLINE_STATE.NOT_APPLICABLE ||
            deadline.state === DEADLINE_STATE.NOT_DUE ? null : (
              <Badge tone={DEADLINE_STATE_TONE[deadline.state]}>
                {deadline.state === DEADLINE_STATE.COMPLETED
                  ? DEADLINE_STATE_LABEL[deadline.state]
                  : deadline.label}
              </Badge>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-500">No deadline</span>
        )}
      </td>
      <td className="px-4 py-2">
        {item.requiresSignature ||
        item.signatureStatus !== SIGNATURE_STATUS.NOT_REQUIRED ? (
          <span className="text-slate-700">
            {SIGNATURE_STATUS_LABEL[item.signatureStatus]}
          </span>
        ) : (
          <span className="text-xs text-slate-500">-</span>
        )}
      </td>
    </tr>
  )
}
