import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '@asps-dms/shared'

/**
 * The account menu, behind a hamburger button.
 *
 * Everything that is about the person rather than the work - who they are,
 * their password, signing out - lives here instead of spread across the header.
 * The sections of the application stay in the navigation below it, so the two
 * kinds of thing are not mixed up.
 *
 * Closes on a click anywhere else and on Escape, because a menu that stays open
 * over the page after you have looked away is a menu you have to dismiss twice.
 */
export function UserMenu({
  user,
  signingOut,
  onSignOut,
}: {
  user: AuthUser
  signingOut: boolean
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-700 shadow-sm hover:bg-slate-50"
      >
        {/* Drawn rather than imported: three lines need no icon library, and a
            library loaded for three lines is a dependency to keep updated. */}
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M2 4.5h14M2 9h14M2 13.5h14"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-card border border-slate-200 bg-white shadow-lg"
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-medium text-slate-900">{user.fullName}</p>
            <p className="text-xs text-slate-500">
              {user.username} &middot; {user.role}
            </p>
          </div>

          <Link
            to="/change-password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            Change password
          </Link>

          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
