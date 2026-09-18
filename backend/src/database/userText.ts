import type { UserListing } from '../repositories/user.repository.js'

/**
 * One line of `npm run user:list`.
 *
 * Kept apart from the CLI so it can be tested without a database: cli.ts runs
 * its command on import, which is right for a command and wrong for a test.
 * Username, role, full name, and the notes an administrator acts on. No
 * passwords, no hashes - those never leave the database.
 */
export function describeUser(user: UserListing): string {
  const notes = [
    user.isActive ? null : 'disabled',
    user.mustChangePassword ? 'must change password' : null,
    user.lastLoginAt ? null : 'never signed in',
  ].filter((note): note is string => note !== null)

  return (
    `${user.username.padEnd(20)} ${user.role.padEnd(7)} ${user.fullName}` +
    (notes.length > 0 ? `  (${notes.join(', ')})` : '')
  )
}
