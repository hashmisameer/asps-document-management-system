import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALL_ROLES,
  ROLES,
  createUserSchema,
  type CreateUserInput,
  type Role,
  type UserListItem,
} from '@asps-dms/shared'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Modal } from '../../components/ui/Modal.js'
import { Select } from '../../components/ui/Select.js'
import { TextField } from '../../components/ui/TextField.js'
import { ApiError } from '../../lib/apiError.js'
import { formatDateTime } from '../../lib/format.js'
import { useAuth } from '../auth/useAuth.js'
import { createUser, fetchUsers, resetUserPassword, updateUser, userKeys } from './api.js'
import {
  ROLE_LABEL,
  actionRefusal,
  filterCounts,
  filterUsers,
  roleDialogNote,
  signatureCell,
  statusCell,
  type UserFilter,
} from './userText.js'

/**
 * Who has a login, and what an administrator can do about it.
 *
 * One table, eight users, a filter above it. Inactive users are shown greyed
 * in the same table rather than hidden on another tab: with eight people
 * there is nothing to hide. The column that earns the screen is Signature -
 * an HR user with none has no authorising signature to stamp, and every
 * document they upload comes out partly stamped until they add one; that
 * has to be visible at a glance, and until this screen it was visible
 * nowhere.
 *
 * NO DELETE. A user is deactivated, never removed - documents were signed in
 * their name. And two things the server refuses whatever this screen shows:
 * deactivating or demoting yourself, and deactivating or demoting the last
 * active administrator. The buttons are disabled with the reason so nobody is
 * offered a click that answers 409.
 */

type Dialog =
  | { kind: 'add' }
  | { kind: 'reset'; user: UserListItem }
  | { kind: 'role'; user: UserListItem }
  | { kind: 'active'; user: UserListItem; to: boolean }
  | null

export function UsersPage() {
  const { user: me } = useAuth()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<UserFilter>('active')
  const [dialog, setDialog] = useState<Dialog>(null)

  const users = useQuery({ queryKey: userKeys.all, queryFn: fetchUsers })
  const all = users.data ?? []
  const shown = filterUsers(all, filter)
  const counts = filterCounts(all)
  const activeAdmins = all.filter((u) => u.isActive && u.role === ROLES.ADMIN).length
  const error = users.error instanceof ApiError ? users.error : null

  const refresh = () => queryClient.invalidateQueries({ queryKey: userKeys.all })

  return (
    <main>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Users</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Everyone with a login. A user is deactivated, never deleted: documents were signed in
            their name. Passwords are never seen here - a new account or a reset gets a temporary
            password, shown once, that the person changes at their next sign-in.
          </p>
        </div>
        <Button onClick={() => setDialog({ kind: 'add' })}>Add user</Button>
      </header>

      {error ? (
        <div className="mt-4">
          <Alert title="The users could not be loaded" referenceId={error.referenceId}>
            {error.message}
          </Alert>
        </div>
      ) : null}

      {/* All / Active / Inactive. Active by default: the people who can sign in. */}
      <div className="mt-4 flex gap-1" role="group" aria-label="Show">
        {(
          [
            ['active', 'Active'],
            ['inactive', 'Inactive'],
            ['all', 'All'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={
              filter === value
                ? 'rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white'
                : 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50'
            }
          >
            {label} <span className="opacity-70">({counts[value]})</span>
          </button>
        ))}
      </div>

      <section className="mt-3 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Last sign-in</th>
              <th className="px-4 py-2 font-medium">Signature</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((user) => (
              <UserRow
                key={user.userId}
                user={user}
                me={me}
                activeAdmins={activeAdmins}
                onReset={() => setDialog({ kind: 'reset', user })}
                onRole={() => setDialog({ kind: 'role', user })}
                onActive={(to) => setDialog({ kind: 'active', user, to })}
              />
            ))}
            {users.isPending ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  {filter === 'inactive' ? 'Nobody is inactive.' : 'No users.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {dialog?.kind === 'add' ? (
        <AddUserDialog onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog?.kind === 'reset' ? (
        <ResetPasswordDialog user={dialog.user} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog?.kind === 'role' ? (
        <ChangeRoleDialog user={dialog.user} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog?.kind === 'active' ? (
        <ActiveDialog
          user={dialog.user}
          to={dialog.to}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* One row                                                                     */
/* -------------------------------------------------------------------------- */

function UserRow({
  user,
  me,
  activeAdmins,
  onReset,
  onRole,
  onActive,
}: {
  user: UserListItem
  me: { userId: number } | null
  activeAdmins: number
  onReset: () => void
  onRole: () => void
  onActive: (to: boolean) => void
}) {
  const status = statusCell(user)
  const signature = signatureCell(user)
  const self = me ?? { userId: -1 }
  const cannotDeactivate = actionRefusal('deactivate', user, self, activeAdmins)
  const cannotChangeRole = actionRefusal('changeRole', user, self, activeAdmins)
  const muted = !user.isActive ? 'text-slate-400' : ''

  return (
    <tr className={`align-top ${muted}`}>
      <td
        className={`px-4 py-2 font-medium ${user.isActive ? 'text-slate-900' : 'text-slate-400'}`}
      >
        {user.fullName}
        {me && user.userId === me.userId ? (
          <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>
        ) : null}
      </td>
      <td className={`px-4 py-2 font-mono text-xs ${muted}`}>{user.username}</td>
      <td className={`px-4 py-2 ${muted}`}>{ROLE_LABEL[user.role]}</td>
      <td className="px-4 py-2">
        {/* A fact about the account, in a quiet tone. 'Has not signed in yet'
            is information - who was given an account and never used it - not
            a warning, so it is grey like the others. */}
        <span
          className={
            status.tone === 'inactive'
              ? 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500'
              : status.tone === 'fact'
                ? 'text-xs text-slate-600'
                : 'text-xs text-slate-600'
          }
        >
          {status.text}
        </span>
      </td>
      <td className={`px-4 py-2 text-xs ${muted || 'text-slate-600'}`}>
        {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'never'}
      </td>
      <td className="px-4 py-2">
        {/* 'none' is the cell this screen exists for, so it is the one thing
            here with colour. 'not needed' says a Viewer never signs anything -
            a dash would read as 'unknown', and somebody would go and chase them. */}
        <span
          title={signature.hint ?? undefined}
          className={
            signature.tone === 'missing'
              ? 'rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-status-pending'
              : `text-xs ${muted || 'text-slate-500'}`
          }
        >
          {signature.text}
        </span>
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        <RowAction onClick={onReset}>Reset password</RowAction>
        <RowAction onClick={onRole} refusal={cannotChangeRole}>
          Change role
        </RowAction>
        {user.isActive ? (
          <RowAction onClick={() => onActive(false)} refusal={cannotDeactivate}>
            Deactivate
          </RowAction>
        ) : (
          <RowAction onClick={() => onActive(true)}>Reactivate</RowAction>
        )}
      </td>
    </tr>
  )
}

/** A text action; disabled with the reason as its title when the server would refuse it. */
function RowAction({
  onClick,
  refusal = null,
  children,
}: {
  onClick: () => void
  refusal?: string | null
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={refusal !== null}
      title={refusal ?? undefined}
      className="ml-3 text-sm font-medium text-brand-700 hover:text-brand-800 disabled:cursor-not-allowed disabled:text-slate-300"
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* The temporary password, shown once                                           */
/* -------------------------------------------------------------------------- */

function TemporaryPassword({ password, username }: { password: string; username: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm text-slate-700">
        Temporary password for <span className="font-medium">{username}</span>:
      </p>
      <div className="mt-2 flex items-center gap-3">
        <code className="rounded bg-white px-3 py-2 font-mono text-lg tracking-wider text-slate-900">
          {password}
        </code>
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password)
              setCopied(true)
            } catch {
              // Clipboard is not available on plain http from some browsers;
              // the password is on screen to be read.
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Shown once and not stored anywhere in this form. Hand it over in person, not by email or
        chat. They must change it at their next sign-in.
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                     */
/* -------------------------------------------------------------------------- */

const ROLE_OPTIONS = ALL_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))

function AddUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [values, setValues] = useState({ username: '', fullName: '', role: '' as Role | '' })
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CreateUserInput, string>>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [created, setCreated] = useState<{ username: string; temporaryPassword: string } | null>(
    null,
  )

  const save = useMutation({
    mutationFn: createUser,
    onSuccess: (result) => {
      setCreated({ username: result.user.username, temporaryPassword: result.temporaryPassword })
      onDone()
    },
    onError: (error) => {
      const apiError = error instanceof ApiError ? error : null
      setFieldErrors({
        username: apiError?.issueFor('username'),
        fullName: apiError?.issueFor('fullName'),
        role: apiError?.issueFor('role'),
      })
      setFailure(apiError?.message ?? 'The user could not be created.')
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setFailure(null)
    const parsed = createUserSchema.safeParse(values)
    if (!parsed.success) {
      const issues: Partial<Record<keyof CreateUserInput, string>> = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (typeof field === 'string') issues[field as keyof CreateUserInput] ??= issue.message
      }
      setFieldErrors(issues)
      return
    }
    setFieldErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Modal
      open
      title={created ? 'User added' : 'Add user'}
      description={
        created
          ? undefined
          : 'Same rules as the command line: a username, a full name and a role. The password is generated and shown once.'
      }
      onClose={onClose}
      footer={
        created ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="add-user" busy={save.isPending} busyLabel="Adding...">
              Add user
            </Button>
          </>
        )
      }
    >
      {created ? (
        <TemporaryPassword password={created.temporaryPassword} username={created.username} />
      ) : (
        <form id="add-user" onSubmit={submit} className="flex flex-col gap-3">
          {failure ? <Alert>{failure}</Alert> : null}
          <TextField
            label="Username"
            value={values.username}
            onChange={(e) => setValues((v) => ({ ...v, username: e.target.value }))}
            error={fieldErrors.username}
            hint="Letters, digits, dot, underscore or hyphen. It cannot be changed later."
            autoComplete="off"
          />
          <TextField
            label="Full name"
            value={values.fullName}
            onChange={(e) => setValues((v) => ({ ...v, fullName: e.target.value }))}
            error={fieldErrors.fullName}
            autoComplete="off"
          />
          <Select
            label="Role"
            value={values.role}
            placeholder="Choose a role"
            options={ROLE_OPTIONS}
            onChange={(e) => setValues((v) => ({ ...v, role: e.target.value as Role }))}
            error={fieldErrors.role}
          />
        </form>
      )}
    </Modal>
  )
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserListItem
  onClose: () => void
  onDone: () => void
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const reset = useMutation({
    mutationFn: () => resetUserPassword(user.userId),
    onSuccess: onDone,
    onError: (error) =>
      setFailure(error instanceof ApiError ? error.message : 'The password could not be reset.'),
  })

  return (
    <Modal
      open
      title={reset.data ? 'Password reset' : `Reset password for ${user.fullName}`}
      description={
        reset.data
          ? undefined
          : 'A new temporary password is generated and shown once. Every session this user has is ended, and they must change it at their next sign-in.'
      }
      onClose={onClose}
      footer={
        reset.data ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button onClick={() => reset.mutate()} busy={reset.isPending} busyLabel="Resetting...">
              Reset password
            </Button>
          </>
        )
      }
    >
      {failure ? <Alert>{failure}</Alert> : null}
      {reset.data ? (
        <TemporaryPassword password={reset.data.temporaryPassword} username={user.username} />
      ) : null}
    </Modal>
  )
}

function ChangeRoleDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserListItem
  onClose: () => void
  onDone: () => void
}) {
  const { user: me } = useAuth()
  const [role, setRole] = useState<Role>(user.role)
  const [failure, setFailure] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: () => updateUser(user.userId, { role }),
    onSuccess: () => {
      onDone()
      onClose()
    },
    onError: (error) =>
      setFailure(error instanceof ApiError ? error.message : 'The role could not be changed.'),
  })

  return (
    <Modal
      open
      title={`Change role for ${user.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => change.mutate()}
            busy={change.isPending}
            busyLabel="Saving..."
            disabled={role === user.role}
          >
            Change role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {failure ? <Alert>{failure}</Alert> : null}
        <Select
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(e) => setRole(e.target.value as Role)}
        />
        {/* Not obvious, so said here: the joining-date rule reads the role
            name, and changing the role changes it silently. */}
        <p className="text-xs text-slate-600">{roleDialogNote(me?.joiningDateWindowDays ?? 7)}</p>
      </div>
    </Modal>
  )
}

function ActiveDialog({
  user,
  to,
  onClose,
  onDone,
}: {
  user: UserListItem
  to: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: () => updateUser(user.userId, { isActive: to }),
    onSuccess: () => {
      onDone()
      onClose()
    },
    onError: (error) =>
      setFailure(error instanceof ApiError ? error.message : 'The change could not be saved.'),
  })

  return (
    <Modal
      open
      title={to ? `Reactivate ${user.fullName}?` : `Deactivate ${user.fullName}?`}
      description={
        to
          ? 'They can sign in again with the password they had. Reset it separately if they have forgotten it.'
          : 'They can no longer sign in, and any session they have open ends now. Nothing is deleted: documents signed in their name keep their name, and the account can be reactivated later.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            Cancel
          </Button>
          <Button onClick={() => change.mutate()} busy={change.isPending} busyLabel="Saving...">
            {to ? 'Reactivate' : 'Deactivate'}
          </Button>
        </>
      }
    >
      {failure ? <Alert>{failure}</Alert> : null}
    </Modal>
  )
}
