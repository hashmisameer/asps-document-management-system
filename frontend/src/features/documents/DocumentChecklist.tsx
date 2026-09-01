import { useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  DOCUMENT_STATUS_LABEL,
  MAX_DOCUMENT_SIZE_BYTES,
  MIN_IDENTITY_OVERRIDE_REASON_LENGTH,
  PERMISSIONS,
  SIGNATURE_STATUS,
  SIGNATURE_STATUS_LABEL,
  canTransitionSignature,
  deriveDeadline,
  type EmployeeDocument,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, DEADLINE_STATE_TONE, DOCUMENT_STATUS_TONE } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { employeeKeys } from '../employees/api.js'
import { skipSignature } from '../signatures/api.js'
import { ApiError } from '../../lib/apiError.js'
import { formatBytes, formatDate, formatDateTime } from '../../lib/format.js'
import { documentFileUrl, uploadDocument } from './api.js'
import { identityFailureOf, unconfirmedLabels, type IdentityFailure } from './identityFailure.js'

/**
 * The employee's checklist, with the actions each row currently allows.
 *
 * Which buttons exist is decided by two things together: the permission the
 * signed-in role holds, and whether the state machine in
 * shared/src/constants/documents.ts permits that change from where the document
 * is now. The same two checks run on the server, so nothing here is a control -
 * a button that should not be pressed is simply not drawn.
 */
export function DocumentChecklist({
  documents,
  isLoading,
}: {
  documents: EmployeeDocument[] | undefined
  isLoading: boolean
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
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
              File
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {documents?.map((item) => <ChecklistRow key={item.documentId} item={item} />)}

          {documents && documents.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                No document types are configured yet, so this employee has no checklist. Seed them
                from the official company document list.
              </td>
            </tr>
          ) : null}

          {isLoading ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                Loading checklist...
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

function ChecklistRow({ item }: { item: EmployeeDocument }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [failure, setFailure] = useState<string | null>(null)

  // An upload the identity check refused, held with the file that was refused
  // so that accepting it re-sends the same bytes rather than asking the person
  // to find the file again.
  const [refused, setRefused] = useState<
    { file: File; message: string; failure: IdentityFailure } | null
  >(null)
  const [overrideReason, setOverrideReason] = useState('')

  // Every action changes the counts on the employee, and several change what
  // the other buttons should be, so the whole employee prefix is refreshed
  // rather than this one row.
  const refresh = () => queryClient.invalidateQueries({ queryKey: employeeKeys.all })

  const onError = (error: unknown) => {
    setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
  }

  const upload = useMutation({
    mutationFn: ({ file, overrideReason: reasonGiven }: { file: File; overrideReason?: string }) =>
      uploadDocument(item.documentId, file, {
        ...(reasonGiven ? { identityOverrideReason: reasonGiven } : {}),
      }),
    onSuccess: async () => {
      setFailure(null)
      setRefused(null)
      setOverrideReason('')
      await refresh()
    },
    // A refused upload is not an error to report and move on from: it is a
    // question for the person holding the document, so it opens the override
    // rather than printing a sentence they cannot act on.
    onError: (error, variables) => {
      const identity = identityFailureOf(error)
      if (identity && error instanceof ApiError) {
        setFailure(null)
        setRefused({ file: variables.file, message: error.message, failure: identity })
        return
      }
      onError(error)
    },
  })

  const skip = useMutation({
    mutationFn: () => skipSignature(item.documentId),
    onSuccess: async () => {
      setFailure(null)
      await refresh()
    },
    onError,
  })

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // The input is reset immediately, so choosing the same file again after a
    // failure still fires a change event.
    event.target.value = ''
    if (!file) return

    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      // The server enforces this too; checking here saves uploading 40 MB to
      // be told no at the end of it.
      setFailure(`That file is larger than the ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)} MB limit.`)
      return
    }
    setRefused(null)
    setOverrideReason('')
    upload.mutate({ file })
  }

  const deadline = deriveDeadline(item.dueDate, item.status)
  const hasFile = item.originalFileName !== null

  const canUpload = can(PERMISSIONS.DOCUMENT_UPLOAD) && (!hasFile || can(PERMISSIONS.DOCUMENT_REPLACE))
  // There is no verification step. A document is done when its file is in:
  // isDocumentComplete already counts 'Uploaded', so nothing sits overdue
  // waiting for a second person to agree it arrived. A wrong document is
  // Replaced rather than rejected and re-collected.
  //
  // The API still has verify and reject, and the state machine still allows
  // them - removing them from the screen is reversible, removing them from the
  // model would not be.
  // Skipping is a decision someone makes, not a failure: plenty of documents
  // need no signature, and 'Skipped' says a person decided that, where leaving
  // it awaiting review for ever says only that nobody got to it.
  const canSkipSignature =
    can(PERMISSIONS.SIGNATURE_SKIP) &&
    hasFile &&
    canTransitionSignature(item.signatureStatus, SIGNATURE_STATUS.SKIPPED)

  // Positioning a signature needs a file to position it on, and a signature
  // status that is still open: a document already signed is re-signed by
  // saving its placements again, not by a second pass over the same button.
  const canSign =
    can(PERMISSIONS.SIGNATURE_PLACE) &&
    hasFile &&
    item.signatureStatus !== SIGNATURE_STATUS.NOT_REQUIRED &&
    item.signatureStatus !== SIGNATURE_STATUS.SKIPPED

  const busy = upload.isPending || skip.isPending

  return (
    <>
      <tr>
        <td className="px-4 py-2 align-top">
          <span className="font-medium text-slate-900">{item.documentName}</span>
          {item.isMandatory ? <span className="ml-2 text-xs text-slate-500">Mandatory</span> : null}
          {item.requiresSignature || item.signatureStatus !== SIGNATURE_STATUS.NOT_REQUIRED ? (
            <p className="mt-0.5 text-xs text-slate-500">
              {SIGNATURE_STATUS_LABEL[item.signatureStatus]}
            </p>
          ) : null}
        </td>

        <td className="px-4 py-2 align-top">
          {/* A tick for anything with a file against it, so 'in' or 'not in' is
              readable down the column without parsing every status word. */}
          <span className="inline-flex items-center gap-1.5">
            {hasFile ? (
              <span aria-hidden="true" className="font-semibold text-status-verified">
                &#10003;
              </span>
            ) : null}
            <Badge tone={DOCUMENT_STATUS_TONE[item.status]}>
              {DOCUMENT_STATUS_LABEL[item.status]}
            </Badge>
          </span>
          {item.status === DOCUMENT_STATUS.REJECTED && item.rejectionReason ? (
            <p className="mt-1 max-w-56 text-xs text-status-rejected">{item.rejectionReason}</p>
          ) : null}
          {item.verifiedByName ? (
            <p className="mt-1 text-xs text-slate-500">
              by {item.verifiedByName}, {formatDateTime(item.verifiedAt)}
            </p>
          ) : null}
          {/* An accepted-anyway document says so on its face. The whole reason
              the override is stored on the row rather than only in the audit
              trail is that it has to be visible here, months later, without
              knowing to go looking for it. */}
          {item.identityCheck?.status === 'Overridden' ? (
            <p className="mt-1 max-w-56 text-xs text-status-pending">
              Identity check overridden
              {item.identityCheck.overriddenByName
                ? ` by ${item.identityCheck.overriddenByName}`
                : ''}
              {item.identityCheck.overrideReason ? `: ${item.identityCheck.overrideReason}` : ''}
            </p>
          ) : null}
        </td>

        <td className="px-4 py-2 align-top">
          {item.dueDate ? (
            <div className="flex flex-col gap-1">
              <span className="text-slate-700">{formatDate(item.dueDate)}</span>
              {deadline.state === DEADLINE_STATE.NOT_APPLICABLE ||
              deadline.state === DEADLINE_STATE.NOT_DUE ? null : (
                <span>
                  <Badge tone={DEADLINE_STATE_TONE[deadline.state]}>{deadline.label}</Badge>
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-500">No deadline</span>
          )}
        </td>

        <td className="px-4 py-2 align-top">
          {hasFile ? (
            <div className="text-xs text-slate-600">
              <p className="max-w-48 truncate" title={item.originalFileName ?? undefined}>
                {item.originalFileName}
              </p>
              <p className="text-slate-500">
                {formatBytes(item.fileSizeBytes)}
                {item.uploadedByName ? ` - ${item.uploadedByName}` : ''}
              </p>
            </div>
          ) : (
            <span className="text-xs text-slate-500">Not uploaded</span>
          )}
        </td>

        <td className="px-4 py-2 align-top">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasFile && can(PERMISSIONS.DOCUMENT_PREVIEW) ? (
              <a
                href={documentFileUrl.preview(item.documentId)}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-brand-700 hover:text-brand-800"
              >
                Preview
              </a>
            ) : null}

            {hasFile && can(PERMISSIONS.DOCUMENT_DOWNLOAD) ? (
              <a
                href={documentFileUrl.download(item.documentId)}
                className="text-sm text-brand-700 hover:text-brand-800"
              >
                Download
              </a>
            ) : null}

            {canUpload ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ALLOWED_DOCUMENT_EXTENSIONS.join(',')}
                  className="hidden"
                  onChange={handleFile}
                />
                <Button
                  variant="secondary"
                  busy={upload.isPending}
                  busyLabel="Uploading..."
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  {hasFile ? 'Replace' : 'Upload'}
                </Button>
              </>
            ) : null}

            {canSign ? (
              <Link
                to={`/documents/${item.documentId}/signature`}
                className="text-sm text-brand-700 hover:text-brand-800"
              >
                Sign
              </Link>
            ) : null}

            {canSkipSignature ? (
              <Button
                variant="ghost"
                busy={skip.isPending}
                busyLabel="Saving..."
                disabled={busy}
                onClick={() => skip.mutate()}
              >
                No signature needed
              </Button>
            ) : null}
          </div>
        </td>
      </tr>

      {refused ? (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-4 py-3">
            {/* The server's own sentence, because it names what it could not
                confirm and says what to do next. */}
            <p className="text-sm font-medium text-slate-900">{refused.message}</p>

            {unconfirmedLabels(refused.failure).length > 0 ? (
              <p className="mt-1 text-xs text-slate-600">
                Not found in {refused.file.name}:{' '}
                <span className="font-medium">
                  {unconfirmedLabels(refused.failure).join(', ')}
                </span>
              </p>
            ) : null}

            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (overrideReason.trim().length < MIN_IDENTITY_OVERRIDE_REASON_LENGTH) return
                upload.mutate({ file: refused.file, overrideReason: overrideReason.trim() })
              }}
            >
              <label className="flex-1">
                <span className="text-xs font-medium text-slate-700">
                  Accepting it anyway? Say why - it is recorded on the document under your name.
                </span>
                <input
                  autoFocus
                  value={overrideReason}
                  maxLength={500}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="The scan is too faint for the Aadhaar number to be read"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <Button
                type="submit"
                busy={upload.isPending}
                busyLabel="Uploading..."
                disabled={overrideReason.trim().length < MIN_IDENTITY_OVERRIDE_REASON_LENGTH}
              >
                Accept and upload
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setRefused(null)
                  setOverrideReason('')
                }}
              >
                Cancel
              </Button>
            </form>
          </td>
        </tr>
      ) : null}

      {failure ? (
        <tr>
          <td colSpan={5} className="px-4 pb-3">
            <Alert title={`${item.documentName} could not be updated`}>{failure}</Alert>
          </td>
        </tr>
      ) : null}
    </>
  )
}
