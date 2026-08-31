import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.js'
import { InternalError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

/**
 * Document storage.
 *
 * Files live in a folder on the company server, outside the repository and
 * outside any web root, and are served only through authenticated, authorised
 * endpoints. Nothing here ever builds a path from something a caller sent.
 *
 * Three rules hold throughout:
 *
 *   1. The stored name is a UUID, never the uploaded name. An uploaded name can
 *      contain path separators, can collide with another employee's file, and
 *      is itself personal data sitting in a directory listing.
 *   2. What is stored in the database is the path RELATIVE to the storage root,
 *      so the volume can be moved or remounted without rewriting every row.
 *   3. Every path read back from the database is re-resolved and checked to be
 *      inside the storage root before it is opened. A row that says
 *      '../../etc/passwd' is a corrupted or hostile row, and it must not be
 *      able to read a file outside the store.
 */

/**
 * Sub-folders of the storage root.
 *
 * Signatures are kept apart from documents because they are reused across every
 * document an employee has, and processed output is kept apart from both
 * because it is DERIVED: it can always be regenerated from the original plus
 * the placements, and losing it loses nothing that cannot be rebuilt.
 */
const DOCUMENTS_FOLDER = 'documents'
const SIGNATURES_FOLDER = 'signatures'
/* The authorising signatures, kept apart from the employees' because they are
   keyed by user id: two ids from different tables must never share a folder,
   or user 7's signature and employee 7's would land in the same place. */
const USER_SIGNATURES_FOLDER = 'user-signatures'
const PROCESSED_FOLDER = 'processed'

export interface StoredFile {
  /** UUID plus extension. Unique, and reveals nothing about the employee. */
  storedFileName: string
  /** Relative to the storage root - this is what goes in the database. */
  relativePath: string
  sizeBytes: number
  sha256: Buffer
}

/**
 * Creates the storage root if it is missing.
 *
 * Called at boot so a wrong or unwritable DOCUMENT_STORAGE_PATH is reported on
 * the first line of output, rather than by the first person who tries to upload
 * a document.
 */
export async function ensureStorageReady(): Promise<void> {
  for (const folder of [
    DOCUMENTS_FOLDER,
    SIGNATURES_FOLDER,
    USER_SIGNATURES_FOLDER,
    PROCESSED_FOLDER,
  ]) {
    await fs.mkdir(path.join(env.storageRoot, folder), { recursive: true })
  }
}

/** Whether the store can actually be written to, for the readiness endpoint. */
export async function checkStorageWritable(): Promise<{ ok: boolean; error?: string }> {
  const probe = path.join(env.storageRoot, `.write-probe-${randomUUID()}`)
  try {
    await fs.mkdir(env.storageRoot, { recursive: true })
    await fs.writeFile(probe, 'ok')
    await fs.unlink(probe)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Writes a file into one of the store's folders.
 *
 * Files are grouped by the owner's numeric id - an employee id, or a user id
 * under the user-signatures folder - rather than by employee code or username:
 * an id never changes, and a directory listing of codes or usernames would be a
 * list of the people this system holds documents about.
 */
async function store(
  folder: string,
  ownerId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  const storedFileName = `${randomUUID()}${extension}`
  const relativePath = path.posix.join(folder, String(ownerId), storedFileName)
  const absolutePath = resolveWithinRoot(relativePath)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  // 'wx' fails rather than overwriting. A UUID collision is not a thing that
  // happens, but silently replacing another employee's document if it did is
  // not a risk worth carrying for nothing.
  await fs.writeFile(absolutePath, buffer, { flag: 'wx' })

  return {
    storedFileName,
    relativePath,
    sizeBytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest(),
  }
}

export async function storeDocument(
  employeeId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  return store(DOCUMENTS_FOLDER, employeeId, buffer, extension)
}

export async function storeSignature(
  employeeId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  return store(SIGNATURES_FOLDER, employeeId, buffer, extension)
}

/** The authorising signature of an HR or Admin user, keyed by their user id. */
export async function storeUserSignature(
  userId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  return store(USER_SIGNATURES_FOLDER, userId, buffer, extension)
}

/**
 * Writes a signed copy of a document.
 *
 * Always a new file rather than an overwrite of the previous processed copy: a
 * browser that is displaying the old one keeps a valid file underneath it, and
 * the previous output stays inspectable if a placement turns out to have been
 * wrong.
 */
export async function storeProcessedDocument(
  employeeId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  return store(PROCESSED_FOLDER, employeeId, buffer, extension)
}

/** Reads a stored file back into memory, for stamping. */
export async function readStoredFile(relativePath: string): Promise<Buffer> {
  return fs.readFile(resolveWithinRoot(relativePath))
}

/**
 * Removes a file that was written for a row that then failed to save.
 *
 * Best effort and never thrown: the caller is already handling an error, and
 * an orphaned file is a housekeeping problem, not a second failure to report.
 */
export async function discardStoredFile(relativePath: string): Promise<void> {
  try {
    await fs.unlink(resolveWithinRoot(relativePath))
  } catch (err) {
    logger.warn({ err, relativePath }, 'Could not remove an orphaned document file')
  }
}

export function openStoredFile(relativePath: string): NodeJS.ReadableStream {
  return createReadStream(resolveWithinRoot(relativePath))
}

export async function storedFileExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(resolveWithinRoot(relativePath))
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a stored path and refuses to leave the storage root.
 *
 * The value comes from the database rather than from a request, so this is not
 * the primary defence - but a path that escapes the store is exactly the kind
 * of thing that turns a small data problem into reading arbitrary files off the
 * server, and checking costs nothing.
 */
export function resolveWithinRoot(relativePath: string): string {
  const absolute = path.resolve(env.storageRoot, relativePath)
  const root = path.resolve(env.storageRoot)

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new InternalError('The stored file path is not inside the document store.')
  }
  return absolute
}
