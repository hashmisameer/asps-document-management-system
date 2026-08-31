import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { PASSWORD_SALT_BYTES, SCRYPT, SCRYPT_ALGORITHM_ID } from '../config/security.js'

/**
 * Password hashing.
 *
 * scrypt from Node's own crypto: memory-hard, no native module to build on the
 * company's Windows server, and no dependency to keep patched. Every hash
 * carries its own random salt, so two users with the same password produce
 * different rows and a precomputed table is worthless.
 *
 * A plain-text password exists only as an argument here. It is never stored,
 * never logged (utils/logger.ts redacts the field names) and never returned.
 */

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

export interface PasswordRecord {
  hash: Buffer
  salt: Buffer
  /** e.g. 'scrypt$32768$8$1' - the parameters the hash was produced with. */
  algorithm: string
}

interface ScryptParameters {
  cost: number
  blockSize: number
  parallelization: number
}

/** Parses 'scrypt$N$r$p'. Returns null for anything else, including a hash
 *  written by some future algorithm this build does not know about. */
function parseAlgorithm(algorithm: string): ScryptParameters | null {
  const parts = algorithm.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null

  const [costText, blockSizeText, parallelText] = parts.slice(1)
  if (costText === undefined || blockSizeText === undefined || parallelText === undefined) {
    return null
  }

  const cost = Number(costText)
  const blockSize = Number(blockSizeText)
  const parallelization = Number(parallelText)

  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelization) ||
    cost < 2 ||
    blockSize < 1 ||
    parallelization < 1
  ) {
    return null
  }

  return { cost, blockSize, parallelization }
}

function derive(password: string, salt: Buffer, params: ScryptParameters): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), salt, SCRYPT.keyLength, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    maxmem: SCRYPT.maxmem,
  })
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES)
  const hash = await derive(password, salt, SCRYPT)
  return { hash, salt, algorithm: SCRYPT_ALGORITHM_ID }
}

/**
 * Verifies a password against a stored record.
 *
 * The comparison is timing-safe: a byte-by-byte early exit would leak how much
 * of a guessed hash was correct. A record whose algorithm this build cannot
 * parse fails closed rather than being treated as a match.
 */
export async function verifyPassword(
  password: string,
  record: PasswordRecord,
): Promise<boolean> {
  const params = parseAlgorithm(record.algorithm)
  if (!params) return false

  const candidate = await derive(password, record.salt, params)
  if (candidate.length !== record.hash.length) return false

  return crypto.timingSafeEqual(candidate, record.hash)
}

/**
 * Burns the same work as a real verification, for a username that does not
 * exist. Without it, "no such user" returns in a millisecond and a real user
 * with a wrong password takes a hundred, which is enough to enumerate accounts.
 */
export async function fakeVerify(password: string): Promise<void> {
  await derive(password, Buffer.alloc(PASSWORD_SALT_BYTES), SCRYPT)
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * policy. The caller has the plain password only during a successful login,
 * which is exactly when the hash can be upgraded.
 */
export function needsRehash(algorithm: string): boolean {
  const params = parseAlgorithm(algorithm)
  if (!params) return true
  return (
    params.cost < SCRYPT.cost ||
    params.blockSize < SCRYPT.blockSize ||
    params.parallelization < SCRYPT.parallelization
  )
}
