import { useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MAX_SIGNATURE_SIZE_BYTES, PERMISSIONS, type EmployeeProfile } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { ApiError } from '../../lib/apiError.js'
import { useAuth } from '../auth/useAuth.js'
import { employeeKeys, employeePhotoUrl, uploadEmployeePhoto } from './api.js'

/**
 * The employee's photograph.
 *
 * Served by an authenticated route rather than embedded in the record, and
 * never cached: a photograph of a member of staff is personal data like
 * everything else here, and a copy sitting in a shared cache on an office
 * machine is exactly what should not happen.
 */
export function PhotoCard({ employee }: { employee: EmployeeProfile }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: (file: File) => uploadEmployeePhoto(employee.employeeId, file),
    onSuccess: async () => {
      setFailure(null)
      await queryClient.invalidateQueries({ queryKey: employeeKeys.all })
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? error.message : 'That photograph could not be saved.')
    },
  })

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset immediately, so choosing the same file again after a failure still
    // fires a change event.
    event.target.value = ''
    if (!file) return

    if (file.size > MAX_SIGNATURE_SIZE_BYTES) {
      setFailure(
        `That image is larger than the ${MAX_SIGNATURE_SIZE_BYTES / (1024 * 1024)} MB limit.`,
      )
      return
    }
    upload.mutate(file)
  }

  const canEdit = can(PERMISSIONS.EMPLOYEE_UPDATE)

  return (
    <section className="rounded-card border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex h-28 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-slate-300 bg-slate-50">
          {employee.hasPhoto ? (
            <img
              // The version in the URL is what makes a replacement show at once
              // instead of the browser reusing the previous face.
              src={employeePhotoUrl(employee.employeeId, employee.photoUpdatedAt)}
              alt={`Photograph of ${employee.employeeName}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="px-2 text-center text-xs text-slate-500">No photo</span>
          )}
        </div>

        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Photograph</h2>
          <p className="mt-1 text-xs text-slate-600">
            {employee.hasPhoto
              ? 'Replacing it keeps the previous file on disk; only the current one is served.'
              : 'A JPEG or PNG, under 2 MB.'}
          </p>

          {canEdit ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={handleFile}
              />
              <div className="mt-3">
                <Button
                  variant="secondary"
                  busy={upload.isPending}
                  busyLabel="Uploading..."
                  onClick={() => fileInput.current?.click()}
                >
                  {employee.hasPhoto ? 'Replace photo' : 'Upload photo'}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {failure ? (
        <div className="mt-3">
          <Alert title="Photograph not saved">{failure}</Alert>
        </div>
      ) : null}
    </section>
  )
}
