import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  roleHasPermission,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
  type Permission,
} from '@asps-dms/shared'
import { setUnauthenticatedHandler } from '../../lib/api.js'
import { AUTH_QUERY_KEY, changePassword, fetchCurrentUser, login, logout } from './api.js'
import { AuthContext, type AuthContextValue } from './authContext.js'

/**
 * Holds the signed-in user.
 *
 * The source of truth is the server: this is a cached answer to /auth/me, never
 * a decision made in the browser. Nothing here stores a token - there is none
 * to store - and nothing is kept in localStorage, so closing the tab leaves
 * nothing behind on a shared office machine.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const { data: user, isPending } = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchCurrentUser,
    // A 401 is an answer, not a failure to retry.
    retry: false,
    staleTime: 60_000,
  })

  useEffect(() => {
    // A session can expire while the user is reading a page. Whichever request
    // discovers it, the app drops to signed-out immediately rather than waiting
    // for the next deliberate auth call.
    setUnauthenticatedHandler(() => {
      queryClient.setQueryData(AUTH_QUERY_KEY, null)
    })
    return () => setUnauthenticatedHandler(null)
  }, [queryClient])

  const signInMutation = useMutation({
    mutationFn: (input: LoginInput) => login(input),
    onSuccess: (signedIn) => {
      queryClient.setQueryData(AUTH_QUERY_KEY, signedIn)
    },
  })

  const changePasswordMutation = useMutation({
    mutationFn: (input: ChangePasswordInput) => changePassword(input),
    onSuccess: (updated) => {
      queryClient.setQueryData(AUTH_QUERY_KEY, updated)
    },
  })

  const signIn = useCallback(
    (input: LoginInput) => signInMutation.mutateAsync(input),
    [signInMutation],
  )

  const submitPasswordChange = useCallback(
    (input: ChangePasswordInput) => changePasswordMutation.mutateAsync(input),
    [changePasswordMutation],
  )

  const signOut = useCallback(async () => {
    await logout()
    // Everything cached was fetched as this user, and this is a shared office
    // machine: the next person to sign in must not see any of it.
    queryClient.clear()
    queryClient.setQueryData(AUTH_QUERY_KEY, null)
  }, [queryClient])

  const can = useCallback(
    (permission: Permission) => (user ? roleHasPermission(user.role, permission) : false),
    [user],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      user: (user as AuthUser | null | undefined) ?? null,
      isLoading: isPending,
      signIn,
      signOut,
      changePassword: submitPasswordChange,
      can,
    }),
    [user, isPending, signIn, signOut, submitPasswordChange, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
