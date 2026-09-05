import { z } from 'zod'
import { ALL_ROLES, type Role } from '../constants/roles.js'
import { booleanQueryParam, paginationQuerySchema } from './common.js'

/**
 * User accounts.
 *
 * A password is never accepted here. An account is created with a temporary
 * one the server generates and shows once, and MustChangePassword is always
 * set - so whoever creates the account does not end up knowing the password of
 * the person who will use it. The same is true of a reset.
 */

const roleEnum = z.enum(ALL_ROLES as unknown as [Role, ...Role[]])

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(100, 'Username must be 100 characters or fewer')
    // A username reaches a login form, a log line and an audit row. Keeping it
    // to a predictable set avoids every question about spaces and case later.
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain only letters, digits, dot, underscore and hyphen'),
  fullName: z
    .string()
    .trim()
    .min(1, 'Full name is required')
    .max(150, 'Full name must be 150 characters or fewer'),
  role: roleEnum,
})

export type CreateUserInput = z.infer<typeof createUserSchema>

/**
 * Update. The username is absent by design: it identifies the account in every
 * audit row already written, and renaming it would quietly rewrite history.
 */
export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(150).optional(),
    role: roleEnum.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })

export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const userListQuerySchema = paginationQuerySchema.extend({
  role: roleEnum.optional(),
  includeInactive: booleanQueryParam.default(false),
})

export type UserListQuery = z.infer<typeof userListQuerySchema>
