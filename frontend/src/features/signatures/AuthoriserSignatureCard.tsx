import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PERMISSIONS } from '@asps-dms/shared'
import { Button } from '../../components/ui/Button.js'
import { useAuth } from '../auth/useAuth.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { SignatureCaptureDialog } from './SignatureCaptureDialog.js'
import { fetchMySignature, mySignatureImageUrl, saveMySignature, signatureKeys } from './api.js'

/**
 * The authoriser's signature: the signed-in user's own.
 *
 * Two people sign a document - the employee, and the HR user who authorises it
 * - so both belong on the screen where signing is arranged. It sits beside the
 * employee's rather than on a page of its own, because nobody thinks to go and
 * set up their own signature in advance; they discover they need one at the
 * moment they are about to place it.
 *
 * It is NOT the employee's, and it is not per-employee: whichever employee's
 * record this is opened from, this card is the signature of whoever is signed
 * in, and it is the one stamped into every Authoriser box they place. That is
 * why the server never accepts a user id here - an authoriser box is always
 * signed by the person saving it, so nobody can sign a document off in a
 * colleague's name.
 */
export function AuthoriserSignatureCard() {
  const { can, user } = useAuth()
  const queryClient = useQueryClient()
  const [signing, setSigning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const signature = useQuery({ queryKey: signatureKeys.mine, queryFn: fetchMySignature })

  const save = useMutation({
    mutationFn: (png: Blob) => saveMySignature(png),
    onSuccess: async () => {
      setFailure(null)
      setSigning(false)
      await queryClient.invalidateQueries({ queryKey: signatureKeys.mine })
    },
    onError: (error) => {
      // The dialog stays open with the ink still on it: a failed save should not
      // mean signing again from nothing.
      setFailure(error instanceof ApiError ? error.message : 'Something went wrong.')
    },
  })

  // Only somebody who signs documents off has any use for one. A Viewer
  // authorises nothing, so they are not offered a pad.
  if (!can(PERMISSIONS.SIGNATURE_UPLOAD)) return null

  const data = signature.data

  return (
    <div className="rounded-card border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">
        Authoriser signature
        <span className="ml-2 font-normal text-slate-500">
          {user ? `- ${user.fullName}` : ''}
        </span>
      </h3>

      <div className="mt-3 flex flex-wrap items-center gap-6">
        <div className="flex h-24 w-56 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50">
          {data?.hasSignature ? (
            <img
              src={mySignatureImageUrl(data.updatedAt)}
              alt="Your signature"
              className="max-h-20 max-w-52 object-contain"
            />
          ) : (
            <span className="px-2 text-center text-xs text-slate-500">
              {signature.isLoading ? 'Loading...' : 'You have no signature on file'}
            </span>
          )}
        </div>

        <div className="text-sm text-slate-600">
          {data?.hasSignature ? (
            <>
              <p>
                {data.widthPx} x {data.heightPx} pixels
              </p>
              <p className="text-xs text-slate-500">Signed {formatDateTime(data.updatedAt)}</p>
            </>
          ) : (
            <p className="max-w-md">
              Yours goes in the Authoriser box when you sign a document off. Sign on the pad once
              and it is reused on everything you authorise.
            </p>
          )}

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
            {data?.hasSignature ? (
              <p className="mt-2 max-w-md text-xs text-slate-500">
                Signing again does not change documents you have already authorised.
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
        onSave={(png) => save.mutate(png)}
      />
    </div>
  )
}
