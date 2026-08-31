import { useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALLOWED_SIGNATURE_MIME_TYPES,
  MAX_SIGNATURE_SIZE_BYTES,
  PERMISSIONS,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { employeeKeys } from '../employees/api.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { fetchSignature, signatureImageUrl, signatureKeys, uploadSignature } from './api.js'

/**
 * The employee's signature.
 *
 * Uploaded once and reused on every document they sign (Section 24), which is
 * why it lives on the employee rather than on any one document.
 *
 * Replacing it deliberately does NOT re-sign documents that were already
 * signed: those carry the signature that was current when they were issued, and
 * quietly changing an image on a document that has already gone out is not
 * something this system does on its own.
 */
export function SignatureCard({ employeeId }: { employeeId: number }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const signature = useQuery({
    queryKey: signatureKeys.employee(employeeId),
    queryFn: () => fetchSignature(employeeId),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadSignature(employeeId, file),
    onSuccess: async () => {
      setFailure(null)
      await queryClient.invalidateQueries({ queryKey: signatureKeys.employee(employeeId) })
      // The employee profile carries hasSignature, so it changes with this.
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
    },
  })

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (file.size > MAX_SIGNATURE_SIZE_BYTES) {
      setFailure(
        `A signature image must be under ${MAX_SIGNATURE_SIZE_BYTES / (1024 * 1024)} MB.`,
      )
      return
    }
    upload.mutate(file)
  }

  const data = signature.data
  const canUpload = can(PERMISSIONS.SIGNATURE_UPLOAD)

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-slate-900">Signature</h2>

      <div className="mt-2 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        {failure ? (
          <div className="mb-3">
            <Alert title="Could not save the signature">{failure}</Alert>
          </div>
        ) : null}

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
                  Uploaded {formatDateTime(data.uploadedAt)}
                </p>
              </>
            ) : (
              <p className="max-w-md">
                A signature is needed before one can be placed on a document. A PNG with a
                transparent background works best.
              </p>
            )}

            {canUpload ? (
              <div className="mt-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept={ALLOWED_SIGNATURE_MIME_TYPES.join(',')}
                  className="hidden"
                  onChange={handleFile}
                />
                <Button
                  variant="secondary"
                  busy={upload.isPending}
                  busyLabel="Uploading..."
                  onClick={() => fileInput.current?.click()}
                >
                  {data?.hasSignature ? 'Replace signature' : 'Upload signature'}
                </Button>
                {data?.hasSignature ? (
                  <p className="mt-2 max-w-md text-xs text-slate-500">
                    Replacing this does not change documents that have already been signed.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
