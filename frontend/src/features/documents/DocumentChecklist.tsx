import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
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
  deriveDeadline,
  type EmployeeDocument,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, DEADLINE_STATE_TONE, DOCUMENT_STATUS_TONE } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { IconButton, IconLink, IconSlot } from '../../components/ui/IconButton.js'
import {
  DownloadIcon,
  EyeIcon,
  ReplaceIcon,
  SignIcon,
  SignedIcon,
  TrashIcon,
  UploadIcon,
} from '../../components/ui/icons.js'
import { useAuth } from '../auth/useAuth.js'
import { employeeKeys } from '../employees/api.js'
import { ApiError } from '../../lib/apiError.js'
import { formatBytes, formatDate } from '../../lib/format.js'
import { documentFileUrl, removeDocumentFile, uploadDocument } from './api.js'
import {
  identityFailureOf,
  overrideReasonHint,
  unconfirmedLabels,
  type IdentityFailure,
} from './identityFailure.js'

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
  employeeHasLeft = false,
}: {
  documents: EmployeeDocument[] | undefined
  isLoading: boolean
  /**
   * Nothing further is collected from somebody who has left.
   *
   * Upload, Replace and Remove come off; Preview and Download stay. What is
   * already on file is exactly what still has to be produced years later, and
   * the reason to open a leaver's folder at all is to read it.
   */
  employeeHasLeft?: boolean
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
          {documents?.map((item) => (
            <ChecklistRow key={item.documentId} item={item} employeeHasLeft={employeeHasLeft} />
          ))}

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

function ChecklistRow({
  item,
  employeeHasLeft,
}: {
  item: EmployeeDocument
  employeeHasLeft: boolean
}) {
  const { can } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [failure, setFailure] = useState<string | null>(null)
  // Asked before removing, because there is no undo on the screen: the bytes
  // are still on disk, but nothing in the application will put them back.
  const [confirmingRemove, setConfirmingRemove] = useState(false)

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

  const remove = useMutation({
    mutationFn: () => removeDocumentFile(item.documentId),
    onSuccess: async () => {
      setFailure(null)
      setConfirmingRemove(false)
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

  // The unit comes with the row, so the confirmation letter reads 'Due in 5
  // months' where everything else reads in days.
  const deadline = deriveDeadline(item.dueDate, item.status, {
    employeeHasLeft,
    deadlineUnit: item.deadlineUnit,
  })

  /**
   * The status, and anything happening to it, in one line.
   *
   * 'Uploaded · reading' rather than 'Uploaded' with 'Reading the document...'
   * underneath: the second form made the row taller while OCR ran and shorter
   * when it finished, so the table jumped under whoever was reading it.
   */
  const identityStatus = item.identityCheck?.status
  const statusText =
    identityStatus === 'Checking'
      ? `${DOCUMENT_STATUS_LABEL[item.status]} · reading`
      : identityStatus === 'Overridden'
        ? `${DOCUMENT_STATUS_LABEL[item.status]} · accepted with reason`
        : DOCUMENT_STATUS_LABEL[item.status]
  const hasFile = item.originalFileName !== null

  const canUpload =
    !employeeHasLeft &&
    can(PERMISSIONS.DOCUMENT_UPLOAD) &&
    (!hasFile || can(PERMISSIONS.DOCUMENT_REPLACE))
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
  // Positioning a signature needs a file to position it on, and a signature
  // status that is still open: a document already signed is re-signed by
  // saving its placements again, not by a second pass over the same button.
  const canSign =
    can(PERMISSIONS.SIGNATURE_PLACE) &&
    hasFile &&
    item.signatureStatus !== SIGNATURE_STATUS.NOT_REQUIRED &&
    item.signatureStatus !== SIGNATURE_STATUS.SKIPPED

  // 'No signature needed' is no longer offered here: the row's five actions are
  // Preview, Download, Replace, Sign and Remove, and skipping was a sixth that
  // existed only in this table. The endpoint is untouched, so it can be put back
  // wherever the office wants it.
  const busy = upload.isPending || remove.isPending

  /**
   * What the Sign button says and whether it does anything.
   *
   * This replaces the two lines that used to sit in the row - a signature word
   * under the document name and a 'No signature needed' button among the
   * actions. Both said the same thing twice and cost every row a line. The
   * state is now readable from the one control somebody would use to change it:
   *
   *   needed, not yet done  enabled
   *   not needed            shown, disabled, and the tooltip says why
   *   already signed        a tick, and the tooltip says so
   *
   * Disabled here means aria-disabled, so the tooltip and the tab stop remain -
   * see IconButton.
   */
  const signature = (() => {
    const status = item.signatureStatus
    if (status === SIGNATURE_STATUS.ADDED) {
      return { show: true, done: true, disabled: true, label: 'Signature added' }
    }
    if (status === SIGNATURE_STATUS.NOT_REQUIRED) {
      return {
        show: true,
        done: false,
        disabled: true,
        label: 'No signature is needed on this document',
      }
    }
    if (status === SIGNATURE_STATUS.SKIPPED) {
      return { show: true, done: false, disabled: true, label: 'Signature skipped' }
    }
    return {
      show: canSign,
      done: false,
      disabled: !canSign,
      label: canSign ? 'Sign' : 'You cannot sign this document',
    }
  })()


  return (
    <>
      <tr>
        <td className="px-4 py-2 align-top">
          <span className="font-medium text-slate-900">{item.documentName}</span>
          {/* Whether the document is expected at all belongs beside its name,
              not in the status column - it is a fact about the document type,
              and it never changes. */}
          <span className="ml-2 align-middle text-xs text-slate-500">
            {item.isMandatory ? 'Mandatory' : 'Not required'}
          </span>
          {/* The signature line that used to sit here is gone. Whether this
              document needs signing, and whether it has been, is said by the
              Sign button - which is where somebody would act on it. */}
        </td>

        <td className="px-4 py-2 align-top">
          {/* ONE badge, on one line.
              This column used to stack a badge, an OCR line, an override line
              and a signature word, so a row could be four lines tall while its
              neighbour was one and the table looked like a list of paragraphs.
              Anything that is a state of the document now reads inside the
              badge; anything that is a REASON somebody must act on - a refusal,
              a rejection - still gets its own line, because those are sentences
              rather than states. */}
          <span className="inline-flex items-center gap-1.5">
            {hasFile ? (
              <span aria-hidden="true" className="font-semibold text-status-verified">
                &#10003;
              </span>
            ) : null}
            <Badge tone={DOCUMENT_STATUS_TONE[item.status]}>{statusText}</Badge>
          </span>

          {item.status === DOCUMENT_STATUS.REJECTED && item.rejectionReason ? (
            <p className="mt-1 max-w-56 text-xs text-status-rejected">{item.rejectionReason}</p>
          ) : null}

          {/* Refused. For an identity card the file has already been taken back
              off - the row is Pending again - so this sentence is the only thing
              saying why nothing is attached. */}
          {item.identityCheck?.status === 'Failed' ? (
            <p className="mt-1 max-w-56 text-xs text-status-rejected">
              {item.identityCheck.failureReason ??
                item.identityCheck.overrideReason ??
                'This document did not match the employee.'}
            </p>
          ) : null}
        </td>

        <td className="px-4 py-2 align-top">
          {item.dueDate ? (
            <div className="flex flex-col gap-1">
              <span className="text-slate-700">{formatDate(item.dueDate)}</span>
              {deadline.state === DEADLINE_STATE.NOT_APPLICABLE ||
              deadline.state === DEADLINE_STATE.COMPLETED ? null : (
                <span>
                  <Badge tone={DEADLINE_STATE_TONE[deadline.state]}>{deadline.label}</Badge>
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-500">{deadline.label}</span>
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
          {/* FIVE FIXED POSITIONS, always in this order. An action that is not
              available leaves its slot empty rather than collapsing, so Remove
              is under Remove on every row and the column can be read down
              rather than searched across.

              On anything narrower than a desktop each button also draws its
              name: hover does not exist on a tablet, and an icon whose label
              can only be reached by hovering has no label there at all. */}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {hasFile && can(PERMISSIONS.DOCUMENT_PREVIEW) ? (
              <IconLink
                label="Preview"
                icon={<EyeIcon />}
                to={documentFileUrl.preview(item.documentId)}
                external
              />
            ) : (
              <IconSlot />
            )}

            {hasFile && can(PERMISSIONS.DOCUMENT_DOWNLOAD) ? (
              <IconLink
                label="Download"
                icon={<DownloadIcon />}
                to={documentFileUrl.download(item.documentId)}
                external
                download
              />
            ) : (
              <IconSlot />
            )}

            {canUpload ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ALLOWED_DOCUMENT_EXTENSIONS.join(',')}
                  className="hidden"
                  onChange={handleFile}
                />
                <IconButton
                  label={hasFile ? 'Replace' : 'Upload'}
                  icon={hasFile ? <ReplaceIcon /> : <UploadIcon />}
                  busy={upload.isPending}
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                />
              </>
            ) : (
              <IconSlot />
            )}

            {/* Signing, said entirely by this one button. */}
            {signature.show ? (
              <IconButton
                label={signature.label}
                icon={signature.done ? <SignedIcon /> : <SignIcon />}
                disabled={signature.disabled}
                onClick={() => navigate(`/documents/${item.documentId}/signature`)}
              />
            ) : (
              <IconSlot />
            )}

            {/* Destructive, so it is set apart by a gap and coloured. The
                confirmation below it is not new - taking a file off has always
                been asked about first. */}
            <span className="ml-2 inline-flex">
              {hasFile && !employeeHasLeft && can(PERMISSIONS.DOCUMENT_REPLACE) ? (
                <IconButton
                  label="Remove"
                  icon={<TrashIcon />}
                  tone="danger"
                  disabled={busy}
                  onClick={() => setConfirmingRemove((current) => !current)}
                />
              ) : (
                <IconSlot />
              )}
            </span>
          </div>
        </td>
      </tr>

      {confirmingRemove ? (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-slate-800">
                Remove {item.originalFileName} from {item.documentName}? The row goes back to
                Pending and keeps its date, and any signature placed on it is cleared.
              </p>
              <Button
                busy={remove.isPending}
                busyLabel="Removing..."
                onClick={() => remove.mutate()}
              >
                Remove the file
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      ) : null}

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
                  placeholder={overrideReasonHint(refused.failure, item.documentName)}
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
