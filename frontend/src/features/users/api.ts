import type { CreateUserInput, UpdateUserInput, UserListItem } from '@asps-dms/shared'
import { api } from '../../lib/api.js'

/**
 * User accounts, for the Users screen. Administrators only, and the server
 * says so on every route.
 *
 * A temporary password comes back exactly once, on create and on reset, and
 * is never asked for again: it is shown, copied, and gone.
 */

export async function fetchUsers(): Promise<UserListItem[]> {
  const response = await api.get<{ users: UserListItem[] }>('/users')
  return response.data.users
}

export interface CreatedUser {
  user: UserListItem
  temporaryPassword: string
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  const response = await api.post<CreatedUser>('/users', input)
  return response.data
}

export async function resetUserPassword(userId: number): Promise<{ temporaryPassword: string }> {
  const response = await api.post<{ temporaryPassword: string }>(`/users/${userId}/reset-password`)
  return response.data
}

export async function updateUser(userId: number, input: UpdateUserInput): Promise<UserListItem> {
  const response = await api.patch<{ user: UserListItem }>(`/users/${userId}`, input)
  return response.data.user
}

export const userKeys = {
  all: ['users'] as const,
}
