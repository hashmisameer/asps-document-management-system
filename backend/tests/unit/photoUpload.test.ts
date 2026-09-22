import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_ACTIONS, ROLES, type AuthUser } from '@asps-dms/shared'
import { prepareForPdf } from '../../src/services/imagePrep.service.js'

/**
 * A photograph uploaded by hand.
 *
 * The one rule: what goes into the store is something pdf-lib can embed. A
 * progressive JPEG - what a phone or a photo editor often saves - cannot be,
 * and the MMC import already re-encodes it; this is the hand-upload path
 * getting the same treatment through the same function, so the ESIC form
 * does not fail with a 415 months after the upload went through.
 */

const db = vi.hoisted(() => ({
  redecideForEmployee: vi.fn(async () => []),
  findById: vi.fn(),
  setPhoto: vi.fn(),
  storePhoto: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  findById: db.findById,
  setPhoto: db.setPhoto,
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  list: vi.fn(),
  listFacets: vi.fn(),
}))

vi.mock('../../src/services/storage.service.js', () => ({
  storePhoto: db.storePhoto,
  storeDocument: vi.fn(),
  discardStoredFile: vi.fn(),
  openStoredFile: vi.fn(),
  readStoredFile: vi.fn(),
  storedFileExists: vi.fn(),
  ensureStorageReady: vi.fn(),
  checkStorageWritable: vi.fn(),
  resolveWithinRoot: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))
vi.mock('../../src/services/autoStampRun.service.js', () => ({
  redecideForEmployee: db.redecideForEmployee,
}))

const employeeService = await import('../../src/services/employee.service.js')

const hr: AuthUser = {
  userId: 3,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}
const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

async function jpeg(options: { progressive?: boolean; orientation?: number } = {}) {
  let pipeline = sharp({
    create: { width: 60, height: 80, channels: 3, background: { r: 120, g: 100, b: 90 } },
  })
  if (options.orientation) pipeline = pipeline.withMetadata({ orientation: options.orientation })
  return pipeline.jpeg({ progressive: options.progressive ?? false, quality: 90 }).toBuffer()
}

async function png() {
  return sharp({ create: { width: 60, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer()
}

const profile = {
  employeeId: 42,
  employeeCode: 'EMP001',
  employeeName: 'Ravi Kumar',
  joiningDate: '2026-09-01',
  isActive: true,
  hasPhoto: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.findById.mockResolvedValue(profile)
  db.setPhoto.mockResolvedValue(undefined)
  db.insertAudit.mockResolvedValue(undefined)
  db.storePhoto.mockImplementation(async (_id: number, buffer: Buffer, extension: string) => ({
    storedFileName: `photo${extension}`,
    relativePath: `photos/42/photo${extension}`,
    sizeBytes: buffer.byteLength,
    sha256: Buffer.alloc(32, 1),
  }))
})

const upload = (buffer: Buffer, name: string) =>
  employeeService.uploadPhoto(42, { originalname: name, buffer, size: buffer.byteLength }, hr, context)

describe('uploadPhoto', () => {
  it('decides again about the employee’s waiting documents once the photograph is saved', async () => {
    await upload(await jpeg(), 'photo.jpg')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(db.redecideForEmployee).toHaveBeenCalledWith(42, hr, context, 'photo saved')
  })

  it('stores a progressive JPEG as baseline, and says so in the audit trail', async () => {
    const source = await jpeg({ progressive: true })
    expect((await sharp(source).metadata()).isProgressive).toBe(true)

    await upload(source, 'photo.jpg')

    const [, stored, extension] = db.storePhoto.mock.calls[0] ?? []
    expect(extension).toBe('.jpg')
    expect(stored.equals(source)).toBe(false)
    const meta = await sharp(stored).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.isProgressive).toBe(false)
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 60, height: 80 })

    expect(db.setPhoto).toHaveBeenCalledWith(42, {
      filePath: 'photos/42/photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: stored.byteLength,
    })
    const entry = db.insertAudit.mock.calls[0]?.[0]
    expect(entry.action).toBe(AUDIT_ACTIONS.EMPLOYEE_UPDATED)
    expect(JSON.parse(entry.metadataJson)).toMatchObject({ change: 'photo', reencoded: true })
  })

  it('stores a baseline JPEG byte for byte', async () => {
    const source = await jpeg()

    await upload(source, 'photo.jpg')

    const [, stored] = db.storePhoto.mock.calls[0] ?? []
    expect(stored.equals(source)).toBe(true)
    expect(JSON.parse(db.insertAudit.mock.calls[0]?.[0].metadataJson)).toMatchObject({
      reencoded: false,
    })
  })

  it('turns a JPEG the right way up when its header says it is on its side', async () => {
    const source = await jpeg({ orientation: 6 })

    await upload(source, 'photo.jpg')

    const [, stored] = db.storePhoto.mock.calls[0] ?? []
    const meta = await sharp(stored).metadata()
    // 60x80 rotated a quarter turn is 80x60, with no orientation left to apply.
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 80, height: 60 })
    expect(meta.orientation ?? 1).toBe(1)
  })

  it('leaves a PNG exactly as it was', async () => {
    const source = await png()

    await upload(source, 'photo.png')

    const [, stored, extension] = db.storePhoto.mock.calls[0] ?? []
    expect(extension).toBe('.png')
    expect(stored.equals(source)).toBe(true)
  })
})

describe('prepareForPdf', () => {
  it('never re-encodes anything but a JPEG, whatever sharp says about it', async () => {
    // An interlaced PNG is 'progressive' to sharp and perfectly fine to pdf-lib.
    const interlaced = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png({ progressive: true })
      .toBuffer()
    expect((await sharp(interlaced).metadata()).isProgressive).toBe(true)

    const prepared = await prepareForPdf(interlaced, 'image/png')
    expect(prepared.converted).toBe(false)
    expect(prepared.buffer.equals(interlaced)).toBe(true)
  })
})
