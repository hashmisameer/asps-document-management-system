import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  DOCUMENT_STATUS_LABEL,
  MAX_DOCUMENT_SIZE_BYTES,
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
import {
  confirmDocumentIdentity,
  documentFileUrl,
  removeDocumentFile,
  setDocumentNotRequired,
  uploadDocument,
} from './api.js'


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

  /* The panel that used to live here - the refused upload, its file held back,
     and a box demanding a written reason before it could be accepted - is gone
     with the refusal itself. Nothing is refused now: the document is stored,
     and if the name could not be read the row says so and offers one button. */

  // Every action changes the counts on the employee, and several change what
  // the other buttons should be, so the whole employee prefix is refreshed
  // rather than this one row.
  const refresh = () => queryClient.invalidateQueries({ queryKey: employeeKeys.all })

  const onError = (error: unknown) => {
    setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
  }

  const upload = useMutation({
    mutationFn: ({ file }: { file: File }) => uploadDocument(item.documentId, file),
    onSuccess: async () => {
      setFailure(null)
      await refresh()
    },
    // Whatever the reading finds, the file is already stored by the time the
    // check runs - so an error here is a real upload failure and nothing else.
    onError,
  })

  /**
   * A person confirming what the machine could not read.
   *
   * One click and nothing to type. Their name and the time go on the row, and
   * the row then says 'Manually confirmed' rather than 'Verified' - so an audit
   * months later can tell the two apart, which is the whole point of recording
   * it at all.
   */
  const confirm = useMutation({
    mutationFn: () => confirmDocumentIdentity(item.documentId),
    onSuccess: async () => {
      setFailure(null)
      await refresh()
    },
    onError,
  })

  /**
   * This document is not asked for of this employee - or it is again.
   *
   * The dashboard counts change with it, so the whole employee prefix is
   * refreshed like every other action here.
   */
  const notRequiredChange = useMutation({
    mutationFn: (next: boolean) => setDocumentNotRequired(item.documentId, next),
    onSuccess: async () => {
      setFailure(null)
      await refresh()
    },
    onError,
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
    setFailure(null)
    upload.mutate({ file })
  }

  /** Not asked for of this employee - ESIC, usually. */
  const notRequired = item.notRequiredAt !== null

  // The unit comes with the row, so the confirmation letter reads 'Due in 5
  // months' where everything else reads in days.
  const deadline = deriveDeadline(item.dueDate, item.status, {
    employeeHasLeft,
    deadlineUnit: item.deadlineUnit,
    notRequired,
  })

  /**
   * The status, and anything happening to it, in one line.
   *
   * 'Uploaded · reading' rather than 'Uploaded' with 'Reading the document...'
   * underneath: the second form made the row taller while OCR ran and shorter
   * when it finished, so the table jumped under whoever was reading it.
   */
  const identityStatus = item.identityCheck?.status
  const statusText = notRequired
    ? 'Not required'
    : identityStatus === 'Checking'
      ? `${DOCUMENT_STATUS_LABEL[item.status]} · reading`
      : identityStatus === 'Overridden'
        ? `${DOCUMENT_STATUS_LABEL[item.status]} · manually confirmed`
        : DOCUMENT_STATUS_LABEL[item.status]
  const hasFile = item.originalFileName !== null

  const canUpload =
    !employeeHasLeft &&
    can(PERMISSIONS.DOCUMENT_UPLOAD) &&
    (!hasFile || can(PERMISSIONS.DOCUMENT_REPLACE))

  /**
   * Whether this row may be set aside, or brought back.
   *
   * DEADLINE_UPDATE - HR and Admin, not a Viewer. It is the same shape of
   * decision as moving a deadline: it changes what the employee is asked for
   * rather than recording something they produced.
   *
   * Never where a file is already in. Undoing it stays available on a row
   * already marked, so a decision made by mistake is one click from being
   * reversed.
   */
  const canSetNotRequired =
    can(PERMISSIONS.DEADLINE_UPDATE) && !employeeHasLeft && (notRequired || !hasFile)
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
          {/* A fact about the document TYPE, which is why it sits beside the
              name rather than in the status column.

              'Optional', not 'Not required' - those words now mean something
              else and more specific on this screen: that THIS employee is not
              asked for this document at all. Optional means the office does not
              chase it; not required means nobody is waiting for it. */}
          <span className="ml-2 align-middle text-xs text-slate-500">
            {item.isMandatory ? 'Mandatory' : 'Optional'}
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
            <Badge tone={notRequired ? 'neutral' : DOCUMENT_STATUS_TONE[item.status]}>
              {statusText}
            </Badge>
          </span>

          {/* Who decided, and when. A document that quietly stopped being
              chased with nobody's name against it is not a decision on the
              record - it is a gap that looks like one. */}
          {notRequired && item.notRequiredByName ? (
            <p className="mt-1 max-w-56 text-xs text-slate-500">
              Marked by {item.notRequiredByName}
              {item.notRequiredAt ? ` on ${formatDate(item.notRequiredAt)}` : ''}
            </p>
          ) : null}

          {/* Setting a document aside, and taking that back.

              A text button under the badge rather than a sixth icon in the
              actions column: that column is five fixed positions read down the
              table, and this is a decision about the ROW rather than an action
              on a file.

              Offered only where there is no file. A document that has arrived
              was evidently required after all, and the server refuses it for
              the same reason. */}
          {canSetNotRequired ? (
            <button
              type="button"
              onClick={() => notRequiredChange.mutate(!notRequired)}
              disabled={notRequiredChange.isPending}
              className="mt-1 text-xs font-medium text-slate-600 underline hover:text-slate-900 disabled:opacity-50"
            >
              {notRequiredChange.isPending
                ? 'Saving...'
                : notRequired
                  ? 'Mark as required'
                  : 'Not required for this employee'}
            </button>
          ) : null}

          {item.status === DOCUMENT_STATUS.REJECTED && item.rejectionReason ? (
            <p className="mt-1 max-w-56 text-xs text-status-rejected">{item.rejectionReason}</p>
          ) : null}

          {/* A WARNING, not a refusal. The document is on file either way.
              Amber rather than red, and with one button: every identity card
              here is a photocopy, so a name OCR cannot read says nothing about
              the document - it is simply not confirmed yet, and a person
              glancing at the page settles it. */}
          {item.identityCheck?.status === 'Failed' ? (
            <div className="mt-1 max-w-56">
              <p className="text-xs text-status-pending">
                {item.identityCheck.failureReason ??
                  'Could not read the name from this document. Please confirm manually.'}
              </p>
              {can(PERMISSIONS.DOCUMENT_UPLOAD) ? (
                <button
                  type="button"
                  onClick={() => confirm.mutate()}
                  disabled={confirm.isPending}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  {confirm.isPending ? 'Confirming...' : 'Confirm this document'}
                </button>
              ) : null}
            </div>
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
