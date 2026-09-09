import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert } from '../components/ui/Alert.js'
import { Button } from '../components/ui/Button.js'
import { useAuth } from '../features/auth/useAuth.js'
import { SignatureCaptureDialog } from '../features/signatures/SignatureCaptureDialog.js'
import {
  fetchMySignature,
  mySignatureImageUrl,
  saveMySignature,
  signatureKeys,
  type SignatureCapture,
} from '../features/signatures/api.js'
import { ApiError } from '../lib/apiError.js'
import { formatDateTime } from '../lib/format.js'

/**
 * The signed-in user's own authorising signature.
 *
 * Two people sign a document: the employee, and whoever authorises it. This is
 * the second one, and it belongs to the account rather than to the company, so
 * a signed document records WHICH member of staff signed it off rather than
 * carrying an anonymous mark that anyone could have applied.
 *
 * There is no screen anywhere that sets somebody else's: the endpoint behind
 * this page has no user id in it at all.
 */
export function MySignaturePage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [signing, setSigning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const signature = useQuery({
    queryKey: signatureKeys.mine,
    queryFn: fetchMySignature,
  })

  const save = useMutation({
    mutationFn: (signed: { png: Blob; capture: SignatureCapture }) =>
      saveMySignature(signed.png, signed.capture),
    onSuccess: async () => {
      setFailure(null)
      setSigning(false)
      await queryClient.invalidateQueries({ queryKey: signatureKeys.mine })
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
    },
  })

  const data = signature.data

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-lg font-semibold text-slate-900">My signature</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        This is the signature stamped on documents you sign off, over your name. Sign once on the
        pen tablet and it is reused on every document you authorise afterwards.
      </p>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-4 shadow-sm">
        {!data?.hasSignature && !signature.isLoading ? (
          <div className="mb-4">
            <Alert tone="info" title="You have no signature yet">
              A document cannot be signed off until you have one on file.
            </Alert>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-6">
          <div className="flex h-28 w-64 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50">
            {data?.hasSignature ? (
              <img
                src={mySignatureImageUrl(data.updatedAt)}
                alt="Your signature"
                className="max-h-24 max-w-60 object-contain"
              />
            ) : (
              <span className="text-xs text-slate-500">
                {signature.isLoading ? 'Loading...' : 'Nothing on file'}
              </span>
            )}
          </div>

          <div className="text-sm text-slate-600">
            <p className="font-medium text-slate-900">{user?.fullName}</p>
            {data?.hasSignature ? (
              <>
                <p>
                  {data.widthPx} x {data.heightPx} pixels
                </p>
                <p className="text-xs text-slate-500">Signed {formatDateTime(data.updatedAt)}</p>
              </>
            ) : null}

            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setFailure(null)
                  setSigning(true)
                }}
              >
                {data?.hasSignature ? 'Sign again' : 'Sign on pad'}
              </Button>
            </div>

            {data?.hasSignature ? (
              <p className="mt-2 max-w-md text-xs text-slate-500">
                Signing again does not change documents you have already signed off. Those keep the
                signature that was current when they were issued.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <SignatureCaptureDialog
        open={signing}
        title="Your signature"
        description="Sign as you would on paper. This is stamped on documents you authorise."
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
