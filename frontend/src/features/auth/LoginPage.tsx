import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { loginSchema } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { TextField } from '../../components/ui/TextField.js'
import { ApiError } from '../../lib/apiError.js'
import { useAuth } from './useAuth.js'

interface FromState {
  from?: string
}

/**
 * Sign in.
 *
 * The form validates with the SAME Zod schema the API validates with, so the
 * two can never disagree about what is acceptable. That check is convenience
 * only - it saves a round trip - and the server rejects the same input again
 * regardless.
 */
export function LoginPage() {
  const { user, isLoading, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({})
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (isLoading) return null
  if (user) {
    // Already signed in - going back to /login should not offer a second one.
    const from = (location.state as FromState | null)?.from
    return <Navigate to={from ?? '/'} replace />
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailure(null)

    const parsed = loginSchema.safeParse({ username, password })
    if (!parsed.success) {
      const issues: { username?: string; password?: string } = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'username' || field === 'password') issues[field] ??= issue.message
      }
      setFieldErrors(issues)
      return
    }

    setFieldErrors({})
    setSubmitting(true)
    try {
      await signIn(parsed.data)
      const from = (location.state as FromState | null)?.from
      void navigate(from ?? '/', { replace: true })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null
      setFailure(apiError)
      // The server deliberately does not say whether the username or the
      // password was wrong, so neither does the form.
      setFieldErrors({
        username: apiError?.issueFor('username'),
        password: apiError?.issueFor('password'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <p className="text-sm font-medium tracking-wide text-brand-700 uppercase">
            ASPS International
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Document Management</h1>
        </header>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
          className="flex flex-col gap-4 rounded-card border border-slate-200 bg-white p-6 shadow-sm"
        >
          {failure ? (
            <Alert title="Could not sign in" referenceId={failure.referenceId}>
              {failure.message}
            </Alert>
          ) : null}

          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            error={fieldErrors.username}
            onChange={(event) => setUsername(event.target.value)}
          />

          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            error={fieldErrors.password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Button type="submit" busy={submitting} busyLabel="Signing in...">
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          Internal use only. Contact your administrator if you cannot sign in.
        </p>
      </div>
    </main>
  )
}
