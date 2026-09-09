import { useQuery } from '@tanstack/react-query'
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  isIdentityCard,
  type DocumentType,
} from '@asps-dms/shared'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { deadlineText } from './deadlineText.js'
import { documentTypeKeys, listDocumentTypes } from './api.js'

/** What the file picker offers, taken from the one list the server enforces. */
const ACCEPTED_UPLOAD_EXTENSIONS = ALLOWED_DOCUMENT_EXTENSIONS.join(',')

/**
 * The documents this employee will be asked for, listed while they are added.
 *
 * Creating an employee materialises one checklist row per active document type,
 * so this is not a preview of a decision anybody makes here - it is what is
 * about to happen.
 *
 * The two IDENTITY CARDS can be attached here, because they are usually in the
 * room while somebody is being entered. They cannot be uploaded before the
 * record exists - there is no row to attach them to - so the files are held and
 * sent the moment it does.
 *
 * THE DEADLINES ARE NOT EDITABLE, and are shown rather than asked for. Each one
 * is computeDueDate against the joining date - the same function the server
 * uses when it writes the row - so what is on screen is what will be stored.
 * They were typeable, and a date typed here was written into the audit trail as
 * a deliberate override of a decision nobody had made; the deadline belongs to
 * the document type, and Settings is where it is changed.
 */

/**
 * One identity document as it is being attached.
 *
 * These two cards are read against the typed employee name BEFORE the record
 * exists, so a slot also holds what that reading found.
 *
 * IT NEVER HOLDS A REFUSAL. Every one of these cards is a low-contrast
 * photocopy and OCR failing to read a name off one says nothing about the
 * document, so a card that does not read is attached exactly like one that
 * does - the difference is only whether the screen says the name was confirmed
 * automatically or asks somebody to confirm it.
 */
export interface AttachedDocument {
  file: File
  /**
   * 'verified'    - the name was read off it and matched
   * 'unconfirmed' - it was not, which is ordinary. The file is attached anyway.
   */
  state: 'checking' | 'verified' | 'unconfirmed'
  /** The warning to show. Set only in the 'unconfirmed' state. */
  problem?: string
  /** What the document seemed to say, when it disagreed and could be read. */
  nameFound?: string | null
  /** True once a person has looked at the page and confirmed it. */
  confirmed?: boolean
  /**
   * The name this was last checked against.
   *
   * Compared when the name changes, so a correction re-checks the cards but a
   * finished check is not started again on every render.
   */
  checkedAgainst?: string
}

export interface SelectedFiles {
  [documentTypeId: number]: AttachedDocument
}

/**
 * True once this slot holds a document that may be created with the employee.
 *
 * Which is any file whose reading has finished, confirmed or not. A card the
 * machine could not read is still the card.
 */
export function isAttached(entry: AttachedDocument | undefined): boolean {
  if (!entry) return false
  return entry.state !== 'checking'
}

/**
 * The types that must be attached before an employee can be created.
 *
 * Reads `requiredAtCreation`, NOT `isMandatory`. The two used to be the same
 * flag, so a document being mandatory - meaning it must be collected, chased
 * and counted - also meant nobody could be entered without it in the room.
 * Nothing is required at creation now, so this is normally empty; the checklist
 * does the chasing.
 */
export function missingMandatory(
  types: readonly DocumentType[] | undefined,
  files: SelectedFiles,
): DocumentType[] {
  return (types ?? []).filter(
    (type) => type.requiredAtCreation && !isAttached(files[type.documentTypeId]),
  )
}

export function RequiredDocuments({
  joiningDate,
  files,
  onFile,
  onAccept,
  canCheck,
  showMissing,
}: {
  joiningDate: string
  files: SelectedFiles
  onFile: (documentTypeId: number, file: File | null) => void
  /** A person has looked at the card and says it is the right one. */
  onAccept: (documentTypeId: number) => void
  /** False while the employee name is empty: there is nothing to check against. */
  canCheck: boolean
  /** True once someone has tried to save, so a gap is called out rather than pre-empted. */
  showMissing: boolean
}) {
  const types = useQuery({
    queryKey: documentTypeKeys.all,
    queryFn: () => listDocumentTypes(),
    staleTime: 5 * 60 * 1000,
  })

  if (types.isLoading) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading the document list...
      </p>
    )
  }

  if (!types.data || types.data.length === 0) return null

  // A half-typed date gives no deadlines rather than nonsense ones.
  const validJoiningDate = /^\d{4}-\d{2}-\d{2}$/.test(joiningDate) ? joiningDate : null


  const cards = types.data.filter((type) => isIdentityCard(type.documentCode))

  return (
    <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">
        Documents to collect ({types.data.length})
      </h2>
      <p className="mt-1 text-xs text-slate-600">
        {cards.map((type) => type.documentName).join(' and ')} can be attached now if they are to
        hand. Everything else is collected afterwards, and{' '}
        {validJoiningDate
          ? 'the deadlines below are worked out from the joining date.'
          : 'the deadlines below fill in once a joining date is entered.'}
      </p>

      <ul className="mt-3 divide-y divide-slate-100">
        {types.data.map((type) => {
          const chosen = files[type.documentTypeId]
          const attached = isAttached(chosen)
          const canAttachNow = isIdentityCard(type.documentCode)
          // 'Missing' means the record cannot be created without it, which is
          // requiredAtCreation - not merely mandatory. Nothing is required at
          // creation today; the checklist does the chasing.
          const missing = showMissing && type.requiredAtCreation && !attached

          return (
            <li key={type.documentTypeId} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-slate-800">
                  {type.documentName}
                  {/* 'Required now' means the record cannot be created without
                      it - not that the document is mandatory. Mandatory ones are
                      chased by the checklist afterwards, which is where a
                      deadline and an overdue state actually mean something. */}
                  {type.requiredAtCreation ? (
                    <span className="ml-2 align-middle">
                      <Badge tone="pending">Required now</Badge>
                    </span>
                  ) : null}
                  {type.isMandatory && !type.requiredAtCreation ? (
                    <span className="ml-2 align-middle">
                      <Badge tone="neutral">Mandatory</Badge>
                    </span>
                  ) : null}
                </span>

                <span className="flex items-center gap-2">
                  {/* Green only where the machine actually read the name.
                      Amber where a person did, or has still to - and never red,
                      because nothing here is wrong. */}
                  <Badge
                    tone={
                      chosen?.state === 'verified'
                        ? 'verified'
                        : chosen?.state === 'unconfirmed'
                          ? 'pending'
                          : 'neutral'
                    }
                  >
                    {chosen?.state === 'checking'
                      ? 'Checking...'
                      : chosen?.state === 'verified'
                        ? 'Name verified'
                        : chosen?.confirmed
                          ? 'Manually confirmed'
                          : chosen?.state === 'unconfirmed'
                            ? 'Attached'
                            : 'Pending'}
                  </Badge>
                  {/* Shown, not asked for: the deadline belongs to the document,
                      and it is in the code rather than on this form. */}
                  <span className="w-28 text-right text-xs text-slate-500">
                    {deadlineText(type, joiningDate)}
                  </span>
                </span>
              </div>

              {/* A picker for the identity documents, because they are usually
                  in the room when somebody is being entered - but attaching one
                  is now optional. Offering a picker against all ten would turn
                  adding an employee into a filing session, and the rest have
                  deadlines precisely because they arrive later. */}
              {canAttachNow ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept={ACCEPTED_UPLOAD_EXTENSIONS}
                    aria-label={`${type.documentName} file`}
                    // Nothing can be checked against a name that has not been
                    // typed, and attaching these two on trust is exactly what
                    // this screen used to do.
                    disabled={!canCheck}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null
                      // Cleared so choosing the same file again after a refusal
                      // still fires a change event.
                      event.target.value = ''
                      onFile(type.documentTypeId, file)
                    }}
                    className="text-xs text-slate-600 file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-xs file:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {chosen ? (
                    <span className="truncate text-xs text-slate-500" title={chosen.file.name}>
                      {chosen.file.name}
                    </span>
                  ) : null}
                  {missing ? (
                    <span className="text-xs font-medium text-status-rejected">
                      {type.documentName} is required
                    </span>
                  ) : null}
                </div>
              ) : null}

              {canAttachNow && !canCheck ? (
                <p className="mt-1 text-xs text-slate-500">
                  Enter the employee name first - these documents are checked against it.
                </p>
              ) : null}

              {chosen?.state === 'unconfirmed' && !chosen.confirmed ? (
                <UnreadDocument
                  problem={
                    chosen.problem ??
                    'Could not read the name from this document. Please confirm manually.'
                  }
                  onConfirm={() => onAccept(type.documentTypeId)}
                />
              ) : null}

              {chosen?.confirmed ? (
                <p className="mt-1 text-xs text-status-pending">
                  Confirmed by you - the name could not be read automatically.
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * A card whose name the machine could not read.
 *
 * A WARNING, NOT A REFUSAL, and amber rather than red. The file is attached
 * either way; this asks the person holding the card to say it is the right one.
 *
 * One button and nothing to type. It used to demand a written reason, on the
 * argument that going around a check should leave a mark - but at this company
 * every one of these cards is a photocopy that OCR cannot read, so the mark was
 * being demanded hundreds of times for the ordinary case, and what it collected
 * was hundreds of copies of the same sentence. The mark that matters is who
 * confirmed it and when, and that is recorded without anybody typing.
 */
function UnreadDocument({
  problem,
  onConfirm,
}: {
  problem: string
  onConfirm: () => void
}) {
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-xs text-status-pending">{problem}</p>
      <Button variant="secondary" onClick={onConfirm} className="mt-2">
        Confirm this document
      </Button>
    </div>
  )
}
