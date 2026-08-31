import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MAX_SELF_REGISTRATIONS, registerSchema } from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Select } from '../../components/ui/Select.js'
import { TextField } from '../../components/ui/TextField.js'
import { ApiError } from '../../lib/apiError.js'
import { REGISTRATION_QUERY_KEY, fetchRegistrationStatus, register } from './api.js'
import { useAuth } from './useAuth.js'

/**
 * Registering an account, while there are still places.
 *
 * The form is capped at MAX_SELF_REGISTRATIONS and closes for good once they
 * are used. What is on screen only reflects that: the count is kept in the
 * database and checked again inside the INSERT, so a stale page, a second tab
 * or a hand-made request all meet the same limit.
 *
 * There is no Admin option. A form anyone on the network can reach must not
 * hand out the role that manages every other account - except on a system with
 * no accounts at all, where the first one has to be an Admin, and the server
 * decides that rather than the form.
 */

type Field = 'username' | 'fullName' | 'password' | 'confirmPassword' | 'registrationSecret'

/** ADMIN is absent on purpose - see the note above. */
const ROLE_CHOICES = [
  { value: 'HR', label: 'HR - manages employees and documents' },
  { value: 'VIEWER', label: 'Management - read only' },
] as const

export function RegisterPage() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  const status = useQuery({
    queryKey: REGISTRATION_QUERY_KEY,
    queryFn: fetchRegistrationStatus,
  })

  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<'HR' | 'VIEWER'>('HR')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [secret, setSecret] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({})
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  if (isLoading) return null
  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailure(null)

    const parsed = registerSchema.safeParse({
      username,
      fullName,
      role,
      password,
      confirmPassword,
      ...(secret ? { registrationSecret: secret } : {}),
    })

    if (!parsed.success) {
      const issues: Partial<Record<Field, string>> = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field | undefined
        if (field) issues[field] ??= issue.message
      }
      setFieldErrors(issues)
      return
    }

    setFieldErrors({})
    setSubmitting(true)
    try {
      const created = await register(parsed.data)
      setDone(created.username)
      await status.refetch()
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null
      setFailure(apiError)
      setFieldErrors({
        username: apiError?.issueFor('username'),
        password: apiError?.issueFor('password'),
        confirmPassword: apiError?.issueFor('confirmPassword'),
        registrationSecret: apiError?.issueFor('registrationSecret'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <p className="text-sm font-medium tracking-wide text-brand-700 uppercase">
            ASPS International
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Document Management</h1>
        </header>
        {children}
      </div>
    </main>
  )

  if (done) {
    return shell(
      <div className="rounded-card border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Account created</h2>
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-medium text-slate-800">{done}</span> can now sign in with the
          password you chose.
        </p>
        <div className="mt-4">
          <Button onClick={() => void navigate('/login', { replace: true })}>Go to sign in</Button>
        </div>
      </div>,
    )
  }

  if (status.data && !status.data.open) {
    return shell(
      <div className="rounded-card border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Registration is closed</h2>
        <p className="mt-2 text-sm text-slate-600">
          All {MAX_SELF_REGISTRATIONS} places have been taken. An administrator can still create
          an account for you.
        </p>
        <Link
          to="/login"
          className="mt-4 inline-block text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          Back to sign in
        </Link>
      </div>,
    )
  }

  return shell(
    <>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        className="flex flex-col gap-4 rounded-card border border-slate-200 bg-white p-6 shadow-sm"
      >
        {failure ? (
          <Alert title="Could not register" referenceId={failure.referenceId}>
            {failure.message}
          </Alert>
        ) : null}

        {status.data ? (
          <p className="text-xs text-slate-500">
            {status.data.firstAccount
              ? 'This is the first account on this system, so it will be an administrator.'
              : `${status.data.remaining} of ${MAX_SELF_REGISTRATIONS} places left.`}
          </p>
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
          label="Full name"
          name="fullName"
          autoComplete="name"
          value={fullName}
          error={fieldErrors.fullName}
          onChange={(event) => setFullName(event.target.value)}
        />

        {status.data?.firstAccount ? null : (
          <Select
            label="Role"
            name="role"
            value={role}
            options={ROLE_CHOICES}
            onChange={(event) => setRole(event.target.value as 'HR' | 'VIEWER')}
          />
        )}

        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          error={fieldErrors.password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <TextField
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          error={fieldErrors.confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />

        {status.data?.secretRequired ? (
          <TextField
            label="Registration code"
            name="registrationSecret"
            type="password"
            value={secret}
            error={fieldErrors.registrationSecret}
            onChange={(event) => setSecret(event.target.value)}
          />
        ) : null}

        <Button type="submit" busy={submitting} busyLabel="Creating account...">
          Create account
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-slate-500">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Sign in
        </Link>
      </p>
    </>,
  )
}
