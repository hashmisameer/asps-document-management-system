import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ALL_EXIT_REASONS,
  EXIT_REASON_LABEL,
  type EmployeeProfile,
  type ExitReason,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { DateField } from '../../components/ui/DateField.js'
import { Modal } from '../../components/ui/Modal.js'
import { toApiError } from '../../lib/apiError.js'
import { employeeKeys, markEmployeeLeft } from './api.js'

/**
 * Recording that an employee has left.
 *
 * TWO DATES, and the dialog says why they are two. Somebody resigns on the 1st
 * and works until the 30th; for those thirty days they are still employed,
 * still paid and still on the checklist. Offering one date would force whoever
 * fills this in to pick which of the two facts to lose.
 *
 * The confirmation step is deliberate rather than decorative: this changes what
 * the employee is counted in - headcount, compliance, the reminder digest - and
 * it is the kind of thing that gets clicked on the wrong row.
 */
export function ExitDialog({
  employee,
  open,
  onClose,
}: {
  employee: EmployeeProfile
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const [resignationDate, setResignationDate] = useState(employee.resignationDate ?? '')
  const [lastWorkingDate, setLastWorkingDate] = useState(employee.lastWorkingDate ?? '')
  const [exitReason, setExitReason] = useState<ExitReason>(employee.exitReason ?? 'RESIGNED')
  const [exitNotes, setExitNotes] = useState(employee.exitNotes ?? '')
  const [confirming, setConfirming] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      markEmployeeLeft(employee.employeeId, {
        resignationDate,
        lastWorkingDate,
        exitReason,
        exitNotes: exitNotes.trim() === '' ? null : exitNotes.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
      setConfirming(false)
      onClose()
    },
  })

  // The server checks these too, and against the joining date, which only it
  // knows for certain. Checking here as well means the common mistake is caught
  // before a round trip rather than coming back as a refusal.
  const bothDatesGiven = resignationDate !== '' && lastWorkingDate !== ''
  const outOfOrder = bothDatesGiven && lastWorkingDate < resignationDate
  const beforeJoining =
    (resignationDate !== '' && resignationDate < employee.joiningDate) ||
    (lastWorkingDate !== '' && lastWorkingDate < employee.joiningDate)

  // The server names the offending field in the issue path, so a refusal lands
  // under the date it is about rather than as a sentence at the top.
  const fieldErrors: Partial<Record<string, string>> = {}
  if (save.error) {
    for (const issue of toApiError(save.error).issues) {
      fieldErrors[issue.path] ??= issue.message
    }
  }
  const canSubmit = bothDatesGiven && !outOfOrder && !beforeJoining

  const close = () => {
    setConfirming(false)
    save.reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      title={confirming ? 'Mark as left?' : `Mark ${employee.employeeName} as left`}
      description={
        confirming
          ? undefined
          : 'Their record and documents are kept. Nothing is deleted, and this can be undone.'
      }
      onClose={close}
      footer={
        confirming ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button
              busy={save.isPending}
              busyLabel="Saving..."
              onClick={() => save.mutate()}
            >
              Yes, mark as left
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => setConfirming(true)}>
              Continue
            </Button>
          </div>
        )
      }
    >
      {save.error ? (
        <Alert title="It could not be saved">{toApiError(save.error).message}</Alert>
      ) : null}

      {confirming ? (
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            <span className="font-medium text-slate-900">{employee.employeeName}</span> (
            {employee.employeeCode}) will be recorded as having left on{' '}
            <span className="font-medium text-slate-900">{formatDay(lastWorkingDate)}</span>.
          </p>
          <p>
            Their outstanding documents stop being overdue, and they come off the active
            headcount and the reminder emails. The record itself stays exactly where it is.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <DateField
            label="Resignation date"
            value={resignationDate}
            hint="The day they gave notice."
            error={fieldErrors.resignationDate}
            onChange={(event) => setResignationDate(event.target.value)}
          />
          <DateField
            label="Last working date"
            value={lastWorkingDate}
            hint="They stay active until this day has passed."
            error={fieldErrors.lastWorkingDate ?? (outOfOrder ? 'This cannot be before the resignation date.' : undefined)}
            onChange={(event) => setLastWorkingDate(event.target.value)}
          />

          {beforeJoining ? (
            <p className="text-sm text-red-700">
              Neither date can be before {formatDay(employee.joiningDate)}, when they joined.
            </p>
          ) : null}

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Reason</span>
            <select
              value={exitReason}
              onChange={(event) => setExitReason(event.target.value as ExitReason)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {ALL_EXIT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {EXIT_REASON_LABEL[reason]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Notes (optional)</span>
            <textarea
              value={exitNotes}
              maxLength={1000}
              rows={3}
              onChange={(event) => setExitNotes(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="Anything the four reasons above do not cover"
            />
          </label>
        </div>
      )}
    </Modal>
  )
}

/** DD/MM/YYYY, the way the office writes a date. */
function formatDay(isoDate: string): string {
  if (isoDate === '') return ''
  const [year, month, day] = isoDate.slice(0, 10).split('-')
  return `${day}/${month}/${year}`
}
