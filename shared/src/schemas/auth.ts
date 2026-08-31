import { z } from 'zod'

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(100),
  password: z.string().min(1, 'Password is required').max(200),
})

export type LoginInput = z.infer<typeof loginSchema>

/**
 * Password policy for the local Users table.
 * Deliberately length-led rather than a symbol-class maze: length is what
 * actually resists offline cracking of the stored scrypt hashes.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be 200 characters or fewer')
  .refine((v) => /[a-z]/.test(v), 'Password must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Password must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a digit')

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  })

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

/**
 * Self-registration, which exists only to enrol the office's own staff.
 *
 * Capped: see MAX_SELF_REGISTRATIONS. Once that many accounts have been created
 * this way the route closes permanently, so an open registration form cannot
 * sit on the network indefinitely handing out accounts to a system holding
 * every employee's Aadhaar and PAN numbers.
 */
export const registerSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, 'Username must be at least 3 characters')
      .max(100)
      .regex(
        /^[a-z0-9._-]+$/,
        'Username may use letters, digits, a dot, a dash or an underscore',
      ),
    fullName: z.string().trim().min(1, 'Full name is required').max(150),
    /**
     * ADMIN is deliberately absent.
     *
     * A form anyone on the network can reach must not be able to mint the role
     * that manages every other account. The first account on an empty system is
     * made an Admin by the server, because otherwise nobody could administer
     * it; after that, an Admin is made by an Admin.
     */
    role: z.enum(['HR', 'VIEWER']).default('HR'),
    password: passwordSchema,
    confirmPassword: z.string(),
    /** Required only when the server is configured with a registration secret. */
    registrationSecret: z.string().max(200).optional(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

export type RegisterInput = z.infer<typeof registerSchema>
