import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, type AuthUser } from '@asps-dms/shared'
import { env } from '../config/env.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeSignatureRepository from '../repositories/employeeSignature.repository.js'
import { describeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { inspectSignatureUpload } from './fileValidation.service.js'
import { preparePhoto } from './imagePrep.service.js'
import * as signatureService from './signature.service.js'
import * as storage from './storage.service.js'

/**
 * The employee's photograph and signature, from where another application
 * already keeps them.
 *
 * MMC writes both to two folders on the server, one file per employee named by
 * the eight-digit code: G:\...\Image\00005696.jpg and
 * G:\...\Signature\00005696.jpg. This attaches them to the DMS record so
 * nobody uploads by hand what is already on the disk.
 *
 * THOSE FOLDERS ARE ANOTHER APPLICATION'S. This module opens a file in them
 * for reading and does nothing else - never writes, renames, moves, deletes or
 * re-encodes anything there. Every conversion below happens to the bytes in
 * memory, on their way into the DMS's own store.
 *
 * THIS MODULE HAS ITS OWN RESOLVER. storage.resolveWithinRoot refuses any path
 * outside the DMS store, and must go on refusing; the MMC folders are outside
 * it by definition. mmcImagePath is the one place a path into them is built,
 * and it builds exactly one shape - <dir>/<eight digits>.jpg - from a code that
 * has already matched ^\d{8}$. No text a person typed reaches path.join.
 *
 * WHAT IS ALREADY THERE IS LEFT ALONE. Hundreds of photographs and signatures
 * were uploaded by hand before this existed. An employee who has one is not
 * touched - not replaced, not re-encoded - and the check is per image, so a
 * photo but no signature gets only the signature. `replace` is the CLI's flag
 * and the automatic hook never passes it.
 */

export type MmcImageKind = 'photo' | 'signature'

export type MmcOutcome =
  /** Copied into the store and attached. */
  | 'attached'
  /** The dry run's 'attached': the file is there and would be copied. */
  | 'wouldAttach'
  /** The employee has one already, and it was left alone. */
  | 'alreadyHad'
  /** No <code>.jpg in the folder. */
  | 'noFile'
  /** The code is not eight digits, so there is no file it could be. */
  | 'codeNotUsable'
  /** The file is there and could not be read, or is not an image. Says why. */
  | 'unreadable'
  /** The folder is not configured, or is not reachable. */
  | 'off'

export interface MmcAttachResult {
  photo: MmcOutcome
  signature: MmcOutcome
  /** Why, for 'unreadable'. */
  detail?: Partial<Record<MmcImageKind, string>>
  /** Whether each source file was a progressive JPEG, for the dry-run tally. */
  progressive?: Partial<Record<MmcImageKind, boolean>>
}

export interface MmcDirectories {
  photo?: string | undefined
  signature?: string | undefined
}

export function configuredDirectories(): MmcDirectories {
  return { photo: env.MMC_PHOTO_DIR, signature: env.MMC_SIGNATURE_DIR }
}

export function isConfigured(dirs: MmcDirectories = configuredDirectories()): boolean {
  return Boolean(dirs.photo || dirs.signature)
}

/* -------------------------------------------------------------------------- */
/* The path                                                                    */
/* -------------------------------------------------------------------------- */

const EMPLOYEE_CODE = /^\d{8}$/

/**
 * The one path this module ever opens: <dir>/<code>.jpg, and only for a code
 * that is eight digits. Null for anything else - which is not an error, it is
 * an employee this source cannot have a file for.
 */
export function mmcImagePath(dir: string, employeeCode: string): string | null {
  if (!EMPLOYEE_CODE.test(employeeCode)) return null
  return path.join(dir, `${employeeCode}.jpg`)
}

/**
 * Whether a configured folder can be listed. Checked once per run rather than
 * per employee, so a drive that is not mounted costs one warning, not five
 * hundred.
 */
export async function folderReachable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* The conversions                                                             */
/* -------------------------------------------------------------------------- */

/*
 * A photograph is prepared by imagePrep.service's preparePhoto - the same
 * function the hand-upload path and the stamper use, so a JPEG MMC wrote and
 * a JPEG HR uploaded end up in the store in the same form.
 */

/** Above this brightness a pixel is paper, not ink. */
const PAPER = 235
/** Below this it is fully ink; between the two the edge fades. */
const INK = 180

/**
 * A signature with its paper made transparent, as a PNG.
 *
 * MMC's signatures are JPEGs: ink on an opaque white rectangle. Stamped onto a
 * form, that rectangle would paint white over whatever printed line sits under
 * it. So on the way in, every pixel near white becomes fully transparent and
 * the edge of each stroke fades between paper and ink, and the result is a
 * PNG - which is what a hand-drawn signature from the pad already is.
 *
 * Always converted: the output format is different, and a JPEG signature is
 * never stored as one.
 */
export async function prepareMmcSignature(
  source: Buffer,
): Promise<{ buffer: Buffer; progressive: boolean; converted: boolean }> {
  const meta = await sharp(source, { failOn: 'error' }).metadata()
  const progressive = meta.isProgressive === true

  const { data, info } = await sharp(source, { failOn: 'error' })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = info.channels // 4, after ensureAlpha
  for (let offset = 0; offset < data.length; offset += channels) {
    const r = data[offset] ?? 0
    const g = data[offset + 1] ?? 0
    const b = data[offset + 2] ?? 0
    const brightness = (r + g + b) / 3
    let alpha: number
    if (brightness >= PAPER) alpha = 0
    else if (brightness <= INK) alpha = 255
    else alpha = Math.round((255 * (PAPER - brightness)) / (PAPER - INK))
    data[offset + 3] = alpha
  }

  const buffer = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer()

  return { buffer, progressive, converted: true }
}

/* -------------------------------------------------------------------------- */
/* Attaching                                                                   */
/* -------------------------------------------------------------------------- */

export interface AttachOptions {
  /** Report what would happen and write nothing. */
  dryRun?: boolean
  /** Attach even where the employee already has one. The CLI's flag; never the hook's. */
  replace?: boolean
  /** Where to look. Defaults to the configured folders. */
  dirs?: MmcDirectories
}

interface Employee {
  employeeId: number
  employeeCode: string
}

async function hasAlready(kind: MmcImageKind, employeeId: number): Promise<boolean> {
  if (kind === 'photo') return (await employeeRepository.findPhoto(employeeId)) !== null
  return (await employeeSignatureRepository.findActiveByEmployee(employeeId)) !== null
}

/**
 * One image for one employee. Reads from MMC, converts in memory, and stores
 * through the same validation an upload goes through.
 */
async function attachOne(
  kind: MmcImageKind,
  dir: string | undefined,
  employee: Employee,
  actor: AuthUser,
  context: RequestContext,
  options: AttachOptions,
  result: MmcAttachResult,
): Promise<MmcOutcome> {
  if (!dir) return 'off'

  const sourcePath = mmcImagePath(dir, employee.employeeCode)
  if (sourcePath === null) return 'codeNotUsable'

  if (!options.replace && (await hasAlready(kind, employee.employeeId))) return 'alreadyHad'

  let source: Buffer
  try {
    source = await fs.readFile(sourcePath)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return 'noFile'
    // EBUSY / EPERM: MMC has it open. Reported, not retried; the backfill is the retry.
    result.detail = { ...result.detail, [kind]: describeError(error) }
    return 'unreadable'
  }

  let prepared: { buffer: Buffer; progressive: boolean }
  try {
    prepared = kind === 'photo' ? await preparePhoto(source) : await prepareMmcSignature(source)
  } catch (error) {
    result.detail = { ...result.detail, [kind]: describeError(error) }
    return 'unreadable'
  }
  result.progressive = { ...result.progressive, [kind]: prepared.progressive }

  if (options.dryRun) return 'wouldAttach'

  // The same file shape an upload arrives in, and the same validation: what
  // MMC wrote is trusted no further than what a person uploads.
  const file = {
    originalname: `${employee.employeeCode}${kind === 'photo' ? '.jpg' : '.png'}`,
    buffer: prepared.buffer,
    size: prepared.buffer.byteLength,
  }

  try {
    if (kind === 'photo') {
      const inspected = await inspectSignatureUpload(file)
      const stored = await storage.storePhoto(employee.employeeId, file.buffer, inspected.extension)
      await employeeRepository.setPhoto(employee.employeeId, {
        filePath: stored.relativePath,
        mimeType: inspected.mimeType,
        sizeBytes: stored.sizeBytes,
      })
      await audit.record({
        userId: actor.userId,
        action: AUDIT_ACTIONS.EMPLOYEE_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.EMPLOYEE,
        entityId: employee.employeeId,
        ipAddress: context.ipAddress,
        metadata: {
          change: 'photo',
          source: 'MMC',
          sizeBytes: stored.sizeBytes,
          mimeType: inspected.mimeType,
        },
      })
    } else {
      await signatureService.uploadSignature(employee.employeeId, file, actor, {
        ...context,
        userAgent: 'mmc',
      })
    }
  } catch (error) {
    result.detail = { ...result.detail, [kind]: describeError(error) }
    return 'unreadable'
  }

  return 'attached'
}

/**
 * Both images for one employee, each attached only where there is nothing yet.
 *
 * Never throws: every failure is an outcome in the result, and the caller
 * decides whether to print it or log it.
 */
export async function attachMissing(
  employee: Employee,
  actor: AuthUser,
  context: RequestContext,
  options: AttachOptions = {},
): Promise<MmcAttachResult> {
  const dirs = options.dirs ?? configuredDirectories()
  const result: MmcAttachResult = { photo: 'off', signature: 'off' }
  result.photo = await attachOne('photo', dirs.photo, employee, actor, context, options, result)
  result.signature = await attachOne(
    'signature',
    dirs.signature,
    employee,
    actor,
    context,
    options,
    result,
  )
  return result
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                    */
/* -------------------------------------------------------------------------- */

/** Warned once per process, so an unmounted drive is one line and not five hundred. */
const warnedUnreachable = new Set<string>()

/**
 * Attaches whatever MMC has for a just-created employee. Never throws and
 * never replaces.
 *
 * Called after the employee and their checklist are committed: the record
 * exists whatever happens here, and an image that is missing, a folder that
 * is not mounted, or a file MMC has open must not cost the creation that
 * already succeeded. Silent when the feature is off; one warning per process
 * when a folder is configured and cannot be reached.
 */
export async function attachQuietly(
  employee: Employee,
  actor: AuthUser,
  context: RequestContext,
): Promise<void> {
  const dirs = configuredDirectories()
  if (!isConfigured(dirs)) return

  try {
    const reachable: MmcDirectories = {}
    for (const kind of ['photo', 'signature'] as const) {
      const dir = dirs[kind]
      if (!dir) continue
      if (await folderReachable(dir)) {
        reachable[kind] = dir
      } else if (!warnedUnreachable.has(dir)) {
        warnedUnreachable.add(dir)
        logger.warn({ dir, kind }, 'MMC image folder is not reachable; images will not be attached')
      }
    }
    if (!isConfigured(reachable)) return

    const result = await attachMissing(employee, actor, context, { dirs: reachable })
    logger.info(
      { employeeCode: employee.employeeCode, photo: result.photo, signature: result.signature },
      'MMC images looked up for a new employee',
    )
    if (result.detail) {
      logger.warn(
        { employeeCode: employee.employeeCode, ...result.detail },
        'An MMC image could not be attached',
      )
    }
  } catch (error) {
    logger.error(
      { err: error, employeeCode: employee.employeeCode },
      'Attaching MMC images threw; the employee was created regardless',
    )
  }
}
