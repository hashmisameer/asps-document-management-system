import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { APP_NAME, ORGANISATION_NAME } from '../app/brand.js'
import clsx from 'clsx'
import { visibleNavItems } from '../app/navigation.js'
import { useAuth } from '../features/auth/useAuth.js'
import { UserMenu } from './UserMenu.js'

/**
 * The signed-in shell: header, navigation, and the routed page.
 *
 * The navigation is built from the user's permissions, so a Viewer and an
 * Admin get different menus from the same code and adding a role changes
 * nothing here.
 */
export function AppLayout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)

  const items = visibleNavItems(user?.role ?? null)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
      void navigate('/login', { replace: true })
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="flex flex-col leading-tight">
            <span className="text-xs font-medium tracking-wide text-brand-700 uppercase">
              {ORGANISATION_NAME}
            </span>
            <span className="text-sm font-semibold text-slate-900">{APP_NAME}</span>
          </Link>

          {user ? (
            <UserMenu user={user} signingOut={signingOut} onSignOut={() => void handleSignOut()} />
          ) : null}
        </div>

        <nav aria-label="Main" className="mx-auto max-w-6xl px-6">
          <ul className="flex gap-1">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    clsx(
                      'inline-block border-b-2 px-3 py-2 text-sm',
                      isActive
                        ? 'border-brand-700 font-medium text-brand-800'
                        : 'border-transparent text-slate-600 hover:text-slate-900',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <Outlet />
      </div>
    </div>
  )
}
