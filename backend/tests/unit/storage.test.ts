import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { env } from '../../src/config/env.js'
import * as storage from '../../src/services/storage.service.js'

/**
 * The document store, against the real filesystem.
 *
 * This one is deliberately not mocked: what is being checked is the behaviour
 * of the filesystem calls themselves - that a stored file lands where the
 * returned path says, and that a path which would escape the store is refused.
 * A mock would only assert that the code calls the functions it calls.
 *
 * tests/setup/test-env.ts points DOCUMENT_STORAGE_PATH at a temp folder.
 */

const written: string[] = []

afterAll(async () => {
  await Promise.all(written.map((relativePath) => storage.discardStoredFile(relativePath)))
})

const CONTENT = Buffer.from('%PDF-1.4 pretend document')

describe('storeDocument', () => {
  it('writes the file, under a name that is not the uploaded one', async () => {
    const stored = await storage.storeDocument(42, CONTENT, '.pdf')
    written.push(stored.relativePath)

    expect(stored.storedFileName).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(stored.relativePath).toBe(`documents/42/${stored.storedFileName}`)
    expect(stored.sizeBytes).toBe(CONTENT.byteLength)

    const onDisk = await fs.readFile(path.join(env.storageRoot, stored.relativePath))
    expect(onDisk.equals(CONTENT)).toBe(true)
  })

  it('digests exactly the bytes it stored', async () => {
    const stored = await storage.storeDocument(42, CONTENT, '.pdf')
    written.push(stored.relativePath)

    expect(stored.sha256.toString('hex')).toBe(createHash('sha256').update(CONTENT).digest('hex'))
  })

  it('keeps two uploads of the same file apart', async () => {
    const first = await storage.storeDocument(42, CONTENT, '.pdf')
    const second = await storage.storeDocument(42, CONTENT, '.pdf')
    written.push(first.relativePath, second.relativePath)

    // Identical content, different rows: replacing one must not touch the other.
    expect(first.relativePath).not.toBe(second.relativePath)
  })

  it('reads a stored file back and removes it again', async () => {
    const stored = await storage.storeDocument(7, CONTENT, '.png')

    expect(await storage.storedFileExists(stored.relativePath)).toBe(true)
    await storage.discardStoredFile(stored.relativePath)
    expect(await storage.storedFileExists(stored.relativePath)).toBe(false)
  })
})

describe('resolveWithinRoot', () => {
  it('refuses a path that climbs out of the store', () => {
    // A row saying this is corrupted or hostile; either way it must not be able
    // to read a file outside the document store.
    expect(() => storage.resolveWithinRoot('../../../etc/passwd')).toThrow()
    expect(() => storage.resolveWithinRoot('documents/../../secrets.txt')).toThrow()
  })

  it('accepts an ordinary stored path', () => {
    const resolved = storage.resolveWithinRoot('documents/42/file.pdf')

    expect(resolved.startsWith(path.resolve(env.storageRoot))).toBe(true)
  })

  it('does not treat a sibling folder with the same prefix as inside the store', () => {
    // '<root>-backup' starts with '<root>' as a string but is a different
    // directory; only a real path separator makes it a child.
    expect(() => storage.resolveWithinRoot(path.join('..', `${path.basename(env.storageRoot)}-backup`, 'x.pdf'))).toThrow()
  })
})

describe('checkStorageWritable', () => {
  it('reports the store as writable and leaves no probe behind', async () => {
    const result = await storage.checkStorageWritable()

    expect(result.ok).toBe(true)
    const entries = await fs.readdir(env.storageRoot)
    expect(entries.some((entry) => entry.startsWith('.write-probe-'))).toBe(false)
  })
})
