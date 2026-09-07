import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  EMPLOYMENT_STATUSES,
  EXIT_REASON_LABEL,
  PERMISSIONS,
  type EmployeeProfile,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { DocumentChecklist } from '../documents/DocumentChecklist.js'
import { SignatureCard } from '../signatures/SignatureCard.js'
import { EMPLOYEE_FIELD_GROUPS, visibleFieldsFor } from './employeeFields.js'
import { ExitDialog } from './ExitDialog.js'
import { PhotoCard } from './PhotoCard.js'
import { ApiError } from '../../lib/apiError.js'
import { saveBlob } from '../../lib/download.js'
import { formatDate } from '../../lib/format.js'
import {
  employeeKeys,
  fetchEmployee,
  fetchEmployeeDocuments,
  printEmployeeForm,
  setEmployeeArchived,
  undoEmployeeExit,
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
    /**
     * Asked again while a document is being read.
     *
     * Reading happens after the upload is answered, so the row arrives saying
     * 'Checking' and changes a few seconds later. Without this the person would
     * have to know to refresh the page to find out what happened to a document
     * they just uploaded - which is the whole benefit of the fast upload thrown
     * away again.
     *
     * Only while something is actually being read: once every row has settled
     * the polling stops on its own.
     */
    refetchInterval: (query) =>
      query.state.data?.some((document) => document.identityCheck?.status === 'Checking')
        ? 3000
        : false,
  })

  const archive = useMutation({
    mutationFn: (archived: boolean) => setEmployeeArchived(employeeId, archived),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
  })

  /**
   * This employee's file: the details page, and their documents behind it.
   *
   * Not what the list's 'Print selected' produces - that is still the checklist
   * form, which is the right paper for chasing somebody. This is the answer to
   * 'send me their file', built by the server so every machine gets the same
   * pages.
   */
  const print = useMutation({
    mutationFn: () => printEmployeeForm(employeeId),
    onSuccess: ({ blob, fileName }) => saveBlob(blob, fileName),
  })

  const [exitOpen, setExitOpen] = useState(false)

  const undo = useMutation({
    mutationFn: () => undoEmployeeExit(employeeId),
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
  const printError = print.error instanceof ApiError ? print.error : null

  // An exit exists from the moment it is recorded, which is usually BEFORE the
  // employee has actually gone. Between those two points they are still ACTIVE,
  // so the button offers 'Undo exit' and the banner says 'Leaving on' rather
  // than 'Left on'.
  const hasExit = profile.resignationDate !== null

  return (
    <main>
      <Link to="/employees" className="text-sm text-slate-600 hover:text-slate-900">
        &larr; Employees
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold text-slate-900">
            {profile.employeeName}
            {profile.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? <Badge>Left</Badge> : null}
            {profile.isActive ? null : <Badge>Archived</Badge>}
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{profile.employeeCode}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Gated on DOCUMENT_DOWNLOAD to match the route: this is the
              employee's details followed by their documents, not the checklist
              it used to be, so it is offered to whoever may take documents
              away. Hiding it is a courtesy; the route is what enforces it. */}
          {can(PERMISSIONS.DOCUMENT_DOWNLOAD) ? (
            <Button
              variant="secondary"
              busy={print.isPending}
              busyLabel="Preparing..."
              title="Their details, and every document received, in one PDF"
              onClick={() => print.mutate()}
            >
              Print form
            </Button>
          ) : null}
          {can(PERMISSIONS.EMPLOYEE_UPDATE) ? (
            <Link
              to={`/employees/${employeeId}/edit`}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Edit
            </Link>
          ) : null}
          {can(PERMISSIONS.EMPLOYEE_EXIT) ? (
            hasExit ? (
              <Button
                variant="secondary"
                busy={undo.isPending}
                busyLabel="Working..."
                onClick={() => undo.mutate()}
              >
                Undo exit
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setExitOpen(true)}>
                Mark as Left
              </Button>
            )
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

      {printError ? (
        <div className="mt-3">
          <Alert title="Could not print that" referenceId={printError.referenceId}>
            {printError.message}
          </Alert>
        </div>
      ) : null}

      {hasExit ? (
        <div className="mt-3">
          <Alert
            tone="info"
            title={
              profile.employmentStatus === EMPLOYMENT_STATUSES.LEFT
                ? `Left on ${formatDate(profile.lastWorkingDate)}${profile.exitReason ? ` · ${EXIT_REASON_LABEL[profile.exitReason]}` : ''}`
                : `Leaving on ${formatDate(profile.lastWorkingDate)}${profile.exitReason ? ` · ${EXIT_REASON_LABEL[profile.exitReason]}` : ''}`
            }
          >
            {profile.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? (
              <>
                Their documents are kept and can still be previewed and downloaded. Nothing
                further can be uploaded, and their outstanding documents are no longer counted
                as overdue.
              </>
            ) : (
              <>
                Notice given on {formatDate(profile.resignationDate)}. They are still employed
                until their last working day, so their checklist and deadlines carry on as
                normal until then.
              </>
            )}
            {profile.exitNotes ? (
              <span className="mt-1 block text-slate-600">{profile.exitNotes}</span>
            ) : null}
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

      <ExitDialog employee={profile} open={exitOpen} onClose={() => setExitOpen(false)} />

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
          <DocumentChecklist
            documents={documents.data}
            isLoading={documents.isLoading}
            employeeHasLeft={profile.employmentStatus === EMPLOYMENT_STATUSES.LEFT}
          />
        </div>
      </section>
    </main>
  )
}

/**
 * Everything the record holds, in groups.
 *
 * Read from EMPLOYEE_FIELDS rather than listed here. This page used to keep its
 * own three rows while the form asked for nine, so a date of birth could be
 * typed in and then never seen again - and nothing about either screen said so.
 * A field added to that list appears here without this file changing.
 *
 * An empty field shows a dash rather than disappearing. A row that vanishes
 * when empty is a field nobody knows exists, which is the same as not having
 * asked for it.
 */
function Details({ profile }: { profile: EmployeeProfile }) {
  const fields = visibleFieldsFor(profile)

  return (
    <div className="mt-4 space-y-4">
      {EMPLOYEE_FIELD_GROUPS.map((group) => {
        const inGroup = fields.filter((field) => field.group === group)
        if (inGroup.length === 0) return null

        return (
          <section
            key={group}
            className="rounded-card border border-slate-200 bg-white p-4 shadow-sm"
          >
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {group}
            </h3>

            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {inGroup.map((field) => (
                <div key={field.key}>
                  <dt className="text-xs tracking-wide text-slate-500 uppercase">{field.label}</dt>
                  <dd className="mt-1 text-sm break-words text-slate-900">
                    {field.display(profile)}
                  </dd>
                </div>
              ))}

              {group === 'Identity' ? (
                <div>
                  <dt className="text-xs tracking-wide text-slate-500 uppercase">Photograph</dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {profile.hasPhoto ? 'On file' : '—'}
                  </dd>
                </div>
              ) : null}

              {group === 'Employment' ? (
                <div>
                  <dt className="text-xs tracking-wide text-slate-500 uppercase">
                    Signature on file
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {profile.hasSignature ? 'Yes' : '—'}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        )
      })}
    </div>
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
