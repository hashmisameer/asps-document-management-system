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

/** Sub-folder of the storage root; keeps room for signatures alongside. */
const DOCUMENTS_FOLDER = 'documents'

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
  await fs.mkdir(path.join(env.storageRoot, DOCUMENTS_FOLDER), { recursive: true })
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
 * Writes a document into the store.
 *
 * Files are grouped by employee id rather than by employee code: the id never
 * changes, and a directory listing of codes would be a list of employees.
 */
export async function storeDocument(
  employeeId: number,
  buffer: Buffer,
  extension: string,
): Promise<StoredFile> {
  const storedFileName = `${randomUUID()}${extension}`
  const relativePath = path.posix.join(DOCUMENTS_FOLDER, String(employeeId), storedFileName)
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
