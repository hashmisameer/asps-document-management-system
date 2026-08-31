/**
 * Authentication policy.
 *
 * Kept out of config/env.ts on purpose: these are security decisions, not
 * deployment settings. An operator should not be able to weaken the password
 * hashing cost or switch off account lockout by editing a .env file on the
 * server. Changing any of them is a code change, reviewed like one.
 */

/**
 * scrypt parameters.
 *
 * N = 32768 (2^15), r = 8, p = 1 costs roughly 100 ms and 32 MB per hash on
 * this class of hardware. That is deliberately slow: logins are rare and human,
 * while an attacker holding a stolen Users table needs it to be expensive per
 * guess. maxmem must be raised above Node's 32 MB default, or scrypt refuses
 * these parameters outright.
 */
export const SCRYPT = {
  cost: 32_768,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  maxmem: 128 * 32_768 * 8 * 2,
} as const

/** Written to dbo.Users.PasswordAlgorithm (VARCHAR(30)), parameters included,
 *  so a future cost increase can be detected and the hash upgraded on the next
 *  successful login rather than silently left at the old cost. */
export const SCRYPT_ALGORITHM_ID = `scrypt$${SCRYPT.cost}$${SCRYPT.blockSize}$${SCRYPT.parallelization}`

/** Bytes of salt per user. VARBINARY(64) in the schema, so 32 fits with room. */
export const PASSWORD_SALT_BYTES = 32

/**
 * Account lockout.
 *
 * Five attempts then a fifteen minute lock is enough to make online guessing
 * useless without handing a nuisance a way to lock out a real HR user for the
 * afternoon. The counter resets on any successful login.
 */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5
export const ACCOUNT_LOCK_MINUTES = 15

/** Bytes of entropy in a session token, before base64url encoding. */
export const SESSION_TOKEN_BYTES = 32

/**
 * A session's idle expiry is extended as the user works, but writing to
 * dbo.Sessions on every request would turn a read-heavy page into a write per
 * request. Extending at most once a minute is indistinguishable to the user.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000
