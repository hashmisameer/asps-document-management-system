import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SIGNATURE_SIZE_BYTES, ROLES, type AuthUser } from '@asps-dms/shared'

/**
 * Photographs and signatures from MMC's folders.
 *
 * Real files in a temporary folder, made with sharp so each one is exactly
 * what the case needs - a progressive JPEG, a rotated one, one over the limit,
 * a signature on white paper - and the repositories and the store mocked, so
 * what is asserted is the boundary the office cares about: nothing in the
 * source folder is ever changed, what an employee already has is never
 * touched, and nothing here can throw at the caller.
 */

const db = vi.hoisted(() => ({
  findPhoto: vi.fn(),
  setPhoto: vi.fn(),
  findActiveSignature: vi.fn(),
  replaceActiveSignature: vi.fn(),
  findEmployee: vi.fn(),
  storePhoto: vi.fn(),
  storeSignature: vi.fn(),
  discardStoredFile: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  findPhoto: db.findPhoto,
  setPhoto: db.setPhoto,
  findById: db.findEmployee,
}))

vi.mock('../../src/repositories/employeeSignature.repository.js', () => ({
  findActiveByEmployee: db.findActiveSignature,
  replaceActive: db.replaceActiveSignature,
}))

vi.mock('../../src/services/storage.service.js', () => ({
  storePhoto: db.storePhoto,
  storeSignature: db.storeSignature,
  discardStoredFile: db.discardStoredFile,
  readStoredFile: vi.fn(),
  storedFileExists: vi.fn(),
  storeProcessedDocument: vi.fn(),
  storeDocument: vi.fn(),
  openStoredFile: vi.fn(),
  ensureStorageReady: vi.fn(),
  checkStorageWritable: vi.fn(),
  resolveWithinRoot: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const mmc = await import('../../src/services/mmcImages.service.js')

const hr: AuthUser = {
  userId: 3,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}
const context = { ipAddress: null, userAgent: 'test' }

/* ------------------------------------------------------------------ fixtures */

let root = ''
let photoDir = ''
let signatureDir = ''

/** A flat-colour JPEG of the given size. */
async function jpeg(width: number, height: number, options: { progressive?: boolean } = {}) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ progressive: options.progressive ?? false, quality: 90 })
    .toBuffer()
}

/** A 'signature': black strokes on white paper, as MMC writes one. */
async function signatureOnPaper() {
  const svg = `<svg width="300" height="120" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="120" fill="white"/>
    <path d="M20 90 C 80 10, 140 110, 200 40 S 260 100, 280 30" stroke="black" stroke-width="6" fill="none"/>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
}

/** The bytes of every file in a folder, to prove nothing changed. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const name of await fs.readdir(dir)) out.set(name, await fs.readFile(path.join(dir, name)))
  return out
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'asps-mmc-'))
  photoDir = path.join(root, 'Image')
  signatureDir = path.join(root, 'Signature')
  await fs.mkdir(photoDir)
  await fs.mkdir(signatureDir)

  await fs.writeFile(path.join(photoDir, '00005696.jpg'), await jpeg(600, 800))
  await fs.writeFile(path.join(photoDir, '00005697.jpg'), await jpeg(600, 800, { progressive: true }))
  // Over the upload limit: a large noisy image compresses badly on purpose.
  const noisy = await sharp({
    create: {
      width: 3000,
      height: 4000,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer()
  await fs.writeFile(path.join(photoDir, '00005698.jpg'), noisy)
  await fs.writeFile(path.join(photoDir, '00005699.jpg'), Buffer.from('not an image at all'))

  await fs.writeFile(path.join(signatureDir, '00005696.jpg'), await signatureOnPaper())
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  db.findPhoto.mockResolvedValue(null)
  db.findActiveSignature.mockResolvedValue(null)
  db.findEmployee.mockResolvedValue({ employeeId: 42, employeeCode: '00005696', employeeName: 'R' })
  db.setPhoto.mockResolvedValue(undefined)
  db.replaceActiveSignature.mockResolvedValue(undefined)
  db.insertAudit.mockResolvedValue(undefined)
  db.storePhoto.mockResolvedValue({ relativePath: 'photos/42/p.jpg', storedFileName: 'p.jpg', sizeBytes: 1, sha256: Buffer.alloc(32) })
  db.storeSignature.mockResolvedValue({ relativePath: 'signatures/42/s.png', storedFileName: 's.png', sizeBytes: 1, sha256: Buffer.alloc(32) })
})

/* ------------------------------------------------------------------ the path */

describe('the path into an MMC folder', () => {
  it('is built from an eight-digit code and nothing else', () => {
    expect(mmc.mmcImagePath('G:\\MMC\\Image', '00005696')).toBe(path.join('G:\\MMC\\Image', '00005696.jpg'))
  })

  it('refuses anything that is not eight digits, so nothing typed reaches the path', () => {
    for (const code of ['EMP001', 'ASPS/9656', '5696', '000056960', '..', '../../etc', '00005696.jpg', '', ' 00005696']) {
      expect(mmc.mmcImagePath('G:\\MMC\\Image', code)).toBeNull()
    }
  })
})

/* ------------------------------------------------------------ conversions */

describe('a photograph on its way into the store', () => {
  it('goes in byte for byte when nothing is wrong with it', async () => {
    const source = await fs.readFile(path.join(photoDir, '00005696.jpg'))
    const prepared = await mmc.prepareMmcPhoto(source)

    expect(prepared.converted).toBe(false)
    expect(prepared.progressive).toBe(false)
    expect(prepared.buffer.equals(source)).toBe(true)
  })

  it('is re-encoded as baseline when it was progressive, which pdf-lib cannot embed', async () => {
    const source = await fs.readFile(path.join(photoDir, '00005697.jpg'))
    const prepared = await mmc.prepareMmcPhoto(source)

    expect(prepared.progressive).toBe(true)
    expect(prepared.converted).toBe(true)
    const meta = await sharp(prepared.buffer).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.isProgressive).toBe(false)
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 600, height: 800 })
  })

  it('is shrunk to fit the limit rather than left behind', async () => {
    const source = await fs.readFile(path.join(photoDir, '00005698.jpg'))
    expect(source.byteLength).toBeGreaterThan(MAX_SIGNATURE_SIZE_BYTES)

    const prepared = await mmc.prepareMmcPhoto(source)
    const meta = await sharp(prepared.buffer).metadata()

    expect(prepared.converted).toBe(true)
    expect(prepared.buffer.byteLength).toBeLessThanOrEqual(MAX_SIGNATURE_SIZE_BYTES)
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600)
    expect(meta.isProgressive).toBe(false)
  })
})

describe('a signature on its way into the store', () => {
  it('has its paper made transparent and becomes a PNG', async () => {
    const source = await fs.readFile(path.join(signatureDir, '00005696.jpg'))
    const prepared = await mmc.prepareMmcSignature(source)

    expect(prepared.converted).toBe(true)
    const meta = await sharp(prepared.buffer).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)

    // The corner is paper and is now see-through; the middle of the stroke is ink and is not.
    const { data, info } = await sharp(prepared.buffer).raw().toBuffer({ resolveWithObject: true })
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3] ?? -1
    expect(alphaAt(2, 2)).toBe(0)
    const inkPixels = [...Array(info.width * info.height).keys()].filter(
      (i) => (data[i * info.channels + 3] ?? 0) === 255,
    ).length
    expect(inkPixels).toBeGreaterThan(200)
    // And most of the image is paper.
    const paperPixels = [...Array(info.width * info.height).keys()].filter(
      (i) => (data[i * info.channels + 3] ?? 0) === 0,
    ).length
    expect(paperPixels).toBeGreaterThan((info.width * info.height) / 2)
  })
})

/* -------------------------------------------------------------- attaching */

describe('attaching what MMC holds', () => {
  const dirs = () => ({ photo: photoDir, signature: signatureDir })
  const employee = { employeeId: 42, employeeCode: '00005696' }

  it('attaches both through the same validation an upload goes through', async () => {
    const result = await mmc.attachMissing(employee, hr, context, { dirs: dirs() })

    expect(result).toMatchObject({ photo: 'attached', signature: 'attached' })
    // The photo: stored, recorded, audited with its source.
    expect(db.storePhoto).toHaveBeenCalledWith(42, expect.any(Buffer), '.jpg')
    expect(db.setPhoto).toHaveBeenCalledWith(42, expect.objectContaining({ mimeType: 'image/jpeg' }))
    const photoAudit = db.insertAudit.mock.calls
      .map((call: unknown[]) => call[0] as { metadataJson?: string })
      .find((entry) => entry.metadataJson?.includes('"change":"photo"'))
    expect(photoAudit?.metadataJson).toContain('"source":"MMC"')
    // The signature: through signature.service.uploadSignature, as a PNG.
    expect(db.storeSignature).toHaveBeenCalledWith(42, expect.any(Buffer), '.png')
    expect(db.replaceActiveSignature).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 42, mimeType: 'image/png', uploadedBy: 3 }),
    )
  })

  it('never changes anything in the MMC folders', async () => {
    const before = await snapshot(photoDir)
    const beforeSignatures = await snapshot(signatureDir)

    await mmc.attachMissing(employee, hr, context, { dirs: dirs() })
    await mmc.attachMissing({ employeeId: 43, employeeCode: '00005697' }, hr, context, { dirs: dirs() })
    await mmc.attachMissing({ employeeId: 44, employeeCode: '00005698' }, hr, context, { dirs: dirs() })

    const after = await snapshot(photoDir)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [name, bytes] of before) expect(after.get(name)?.equals(bytes)).toBe(true)
    const afterSignatures = await snapshot(signatureDir)
    for (const [name, bytes] of beforeSignatures) expect(afterSignatures.get(name)?.equals(bytes)).toBe(true)
  })

  it('leaves an employee who already has one completely alone, per image', async () => {
    db.findPhoto.mockResolvedValue({ filePath: 'photos/42/hand.jpg', mimeType: 'image/jpeg' })

    const result = await mmc.attachMissing(employee, hr, context, { dirs: dirs() })

    expect(result).toMatchObject({ photo: 'alreadyHad', signature: 'attached' })
    expect(db.storePhoto).not.toHaveBeenCalled()
    expect(db.setPhoto).not.toHaveBeenCalled()
    expect(db.storeSignature).toHaveBeenCalledTimes(1)
  })

  it('replaces only when asked, and the flag is off by default', async () => {
    db.findPhoto.mockResolvedValue({ filePath: 'photos/42/hand.jpg', mimeType: 'image/jpeg' })

    const untouched = await mmc.attachMissing(employee, hr, context, { dirs: dirs() })
    expect(untouched.photo).toBe('alreadyHad')

    const replaced = await mmc.attachMissing(employee, hr, context, { dirs: dirs(), replace: true })
    expect(replaced.photo).toBe('attached')
  })

  it('writes nothing on a dry run and still says what it would do', async () => {
    const result = await mmc.attachMissing(employee, hr, context, { dirs: dirs(), dryRun: true })

    expect(result).toMatchObject({ photo: 'wouldAttach', signature: 'wouldAttach' })
    expect(result.progressive).toEqual({ photo: false, signature: false })
    expect(db.storePhoto).not.toHaveBeenCalled()
    expect(db.storeSignature).not.toHaveBeenCalled()
    expect(db.setPhoto).not.toHaveBeenCalled()
    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('counts a progressive source on the dry run', async () => {
    const result = await mmc.attachMissing({ employeeId: 43, employeeCode: '00005697' }, hr, context, {
      dirs: dirs(),
      dryRun: true,
    })
    expect(result.progressive?.photo).toBe(true)
  })

  it('reports no file, a code that cannot have one, and a file that is not an image', async () => {
    expect(await mmc.attachMissing({ employeeId: 1, employeeCode: '00000001' }, hr, context, { dirs: dirs() })).toMatchObject({
      photo: 'noFile',
      signature: 'noFile',
    })
    expect(await mmc.attachMissing({ employeeId: 2, employeeCode: 'EMP001' }, hr, context, { dirs: dirs() })).toMatchObject({
      photo: 'codeNotUsable',
      signature: 'codeNotUsable',
    })
    const broken = await mmc.attachMissing({ employeeId: 3, employeeCode: '00005699' }, hr, context, { dirs: dirs() })
    expect(broken.photo).toBe('unreadable')
    expect(broken.detail?.photo).toBeTruthy()
    expect(db.storePhoto).not.toHaveBeenCalled()
  })

  it('is off for an image whose folder is not configured', async () => {
    const result = await mmc.attachMissing(employee, hr, context, { dirs: { photo: photoDir } })
    expect(result).toMatchObject({ photo: 'attached', signature: 'off' })
  })
})

describe('the hook on employee creation', () => {
  it('does nothing and says nothing when the feature is off', async () => {
    // The configured folders come from .env, which the test environment does
    // not set; the hook must return before touching anything.
    await expect(mmc.attachQuietly({ employeeId: 42, employeeCode: '00005696' }, hr, context)).resolves.toBeUndefined()
    expect(db.findPhoto).not.toHaveBeenCalled()
    expect(db.storePhoto).not.toHaveBeenCalled()
  })

  it('reports off when a configured folder is not reachable', async () => {
    expect(await mmc.folderReachable(path.join(root, 'no-such-folder'))).toBe(false)
    expect(await mmc.folderReachable(photoDir)).toBe(true)
  })
})
