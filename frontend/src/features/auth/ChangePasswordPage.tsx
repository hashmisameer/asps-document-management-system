import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { changePasswordSchema } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { TextField } from '../../components/ui/TextField.js'
import { ApiError } from '../../lib/apiError.js'
import { useAuth } from './useAuth.js'

type Field = 'currentPassword' | 'newPassword' | 'confirmPassword'

/**
 * Change your own password.
 *
 * Reached two ways: chosen from the header, or forced by ProtectedRoute when
 * the account still has MustChangePassword set - a first sign-in, or an
 * administrator reset. Nothing else in the app is reachable until it is done.
 */
export function ChangePasswordPage() {
  const { user, changePassword } = useAuth()
  const navigate = useNavigate()

  const [values, setValues] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({})
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const forced = user?.mustChangePassword === true

  const set = (field: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailure(null)

    const parsed = changePasswordSchema.safeParse(values)
    if (!parsed.success) {
      const issues: Partial<Record<Field, string>> = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'currentPassword' || field === 'newPassword' || field === 'confirmPassword') {
          issues[field] ??= issue.message
        }
      }
      setFieldErrors(issues)
      return
    }

    setFieldErrors({})
    setSubmitting(true)
    try {
      await changePassword(parsed.data)
      void navigate('/', { replace: true })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null
      setFailure(apiError)
      setFieldErrors({
        currentPassword: apiError?.issueFor('currentPassword'),
        newPassword: apiError?.issueFor('newPassword'),
        confirmPassword: apiError?.issueFor('confirmPassword'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-md p-6">
      <h1 className="text-xl font-semibold text-slate-900">Change your password</h1>

      {forced ? (
        <div className="mt-3">
          <Alert tone="info" title="A new password is required">
            This account is still using the password it was created with. Set your own before
            continuing.
          </Alert>
        </div>
      ) : null}

      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        className="mt-4 flex flex-col gap-4 rounded-card border border-slate-200 bg-white p-6 shadow-sm"
      >
        {failure ? (
          <Alert title="Could not change your password" referenceId={failure.referenceId}>
            {failure.message}
          </Alert>
        ) : null}

        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={values.currentPassword}
          error={fieldErrors.currentPassword}
          onChange={set('currentPassword')}
        />

        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters, with an uppercase letter, a lowercase letter and a digit."
          value={values.newPassword}
          error={fieldErrors.newPassword}
          onChange={set('newPassword')}
        />

        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={values.confirmPassword}
          error={fieldErrors.confirmPassword}
          onChange={set('confirmPassword')}
        />

        <p className="text-xs text-slate-500">
          Changing your password signs out every other device using this account.
        </p>

        <Button type="submit" busy={submitting} busyLabel="Saving...">
          Change password
        </Button>
      </form>
    </main>
  )
}
