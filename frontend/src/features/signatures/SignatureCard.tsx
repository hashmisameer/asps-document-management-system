import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PERMISSIONS } from '@asps-dms/shared'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { dashboardKeys } from '../dashboard/api.js'
import { employeeKeys } from '../employees/api.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { SignatureCaptureDialog } from './SignatureCaptureDialog.js'
import {
  fetchSignature,
  signatureImageUrl,
  signatureKeys,
  uploadSignature,
  type SignatureCapture,
} from './api.js'

/**
 * The employee's signature.
 *
 * Signed on the pad when the employee is at the desk with the tablet, or
 * uploaded as a scan or photograph of their signature when they are not - the
 * dialog offers both, and the record says which it was.
 *
 * Uploaded once and reused on every document they sign (Section 24), which is
 * why it lives on the employee rather than on any one document.
 *
 * Replacing it deliberately does NOT re-sign documents that were already
 * signed: those carry the signature that was current when they were issued, and
 * quietly changing an image on a document that has already gone out is not
 * something this system does on its own.
 */
export function SignatureCard({
  employeeId,
  employeeName,
}: {
  employeeId: number
  /** Named on the card, so the two signature boxes cannot be confused for each
      other: one says whose it is, and so does the other. */
  employeeName: string
}) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [signing, setSigning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const signature = useQuery({
    queryKey: signatureKeys.employee(employeeId),
    queryFn: () => fetchSignature(employeeId),
  })

  const save = useMutation({
    mutationFn: (signed: { png: Blob; capture: SignatureCapture }) =>
      uploadSignature(employeeId, signed.png, signed.capture),
    onSuccess: async () => {
      setFailure(null)
      setSigning(false)
      await queryClient.invalidateQueries({ queryKey: signatureKeys.employee(employeeId) })
      // The employee profile carries hasSignature, so it changes with this.
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
      // And so does the dashboard: 'Pending employee signature' counts the
      // people who have never signed, and one of them just has. Without this
      // the tile keeps its old number until its cache goes stale, which reads
      // as the signature not having saved.
      await queryClient.invalidateQueries({ queryKey: dashboardKeys.summary })
    },
    onError: (error) => {
      // The dialog stays open with the ink still on it, so a failed save does
      // not mean signing again from nothing.
      setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
    },
  })

  const data = signature.data
  const canSign = can(PERMISSIONS.SIGNATURE_UPLOAD)

  return (
    <div className="rounded-card border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">
        Employee signature
        <span className="ml-2 font-normal text-slate-500">- {employeeName}</span>
      </h3>

      <div className="mt-3">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex h-24 w-56 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50">
            {data?.hasSignature ? (
              <img
                src={signatureImageUrl(employeeId, data.uploadedAt)}
                alt="The employee's signature"
                className="max-h-20 max-w-52 object-contain"
              />
            ) : (
              <span className="text-xs text-slate-500">
                {signature.isLoading ? 'Loading...' : 'No signature on file'}
              </span>
            )}
          </div>

          <div className="text-sm text-slate-600">
            {data?.hasSignature ? (
              <>
                <p>
                  {data.widthPx} x {data.heightPx} pixels
                </p>
                <p className="text-xs text-slate-500">
                  On file since {formatDateTime(data.uploadedAt)}
                </p>
              </>
            ) : (
              <p className="max-w-md">
                A signature is needed before one can be placed on a document. Hand the employee the
                pen tablet and have them sign on the pad, or upload a scan or photograph of their
                signature.
              </p>
            )}

            {canSign ? (
              <div className="mt-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFailure(null)
                    setSigning(true)
                  }}
                >
                  {data?.hasSignature ? 'Replace signature' : 'Add signature'}
                </Button>
                {data?.hasSignature ? (
                  <p className="mt-2 max-w-md text-xs text-slate-500">
                    Replacing it does not change documents that have already been signed.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <SignatureCaptureDialog
        open={signing}
        title="Employee signature"
        description="The employee signs here, or switch to Upload for a scan or photograph of their signature. It is stamped on every document of theirs that needs one."
        busy={save.isPending}
        failure={failure}
        onCancel={() => {
          setSigning(false)
          setFailure(null)
        }}
        onSave={(png, capture) => save.mutate({ png, capture })}
      />
    </div>
  )
}
