import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ROLES, type AuthUser } from '@asps-dms/shared'
import { env } from '../config/env.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import { describeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import type { RequestContext } from './auth.service.js'
import { run as runStampDecision } from './autoStampRun.service.js'
import {
  attachMissing,
  configuredDirectories,
  type MmcAttachResult,
  type MmcImageKind,
} from './mmcImages.service.js'

/**
 * The MMC pickup: a photograph or a signature is taken in the moment it
 * appears in MMC's folder, with nothing asked of anybody.
 *
 * HR adds an employee in the DMS. MMC writes the photograph and the signature
 * into its folders whenever it gets round to it - minutes, hours or days
 * later, and usually not both at once. Creating the employee already takes
 * whatever is there at that moment; what was missing was anything that looked
 * AGAIN. Employee 00006100's photograph was there at creation and came in;
 * the signature arrived later and sat in the folder for ever.
 *
 * TWO EARS AND A NET. fs.watch on each folder hears a file appear and queues
 * it. A sweep every few minutes lists both folders once and queues every
 * file for an employee who still lacks that image. The watcher is the
 * mechanism; the sweep is what makes it honest on a network share, where a
 * watcher can miss files (see below). Both feed one serial queue, so a burst
 * of a thousand events is a thousand cheap checks one after another, not a
 * thousand PDFs opened at once.
 *
 * FOR EACH FILE: wait until it has stopped growing, find the employee - on
 * the books, not archived, not left - attach whichever of the two images they
 * lack through the same attachMissing the creation hook uses, and if anything
 * was attached run the stamp decision again on their documents still waiting
 * for a signature, each in the name of the person who uploaded it. A document
 * left alone for 'the employee has no signature on file' is decided about
 * once more now that they have.
 *
 * NEVER REPLACES. An employee who already has the image is left as they are,
 * exactly as the creation hook and the command leave them. A corrected file
 * in MMC does not follow through - a separate decision for another day.
 *
 * ON A NETWORK SHARE A WATCHER CAN MISS FILES. Windows delivers folder change
 * notifications over SMB as best it can: a burst can overflow the buffer and
 * drop events, some servers do not forward changes made locally on the
 * share's host, and when the connection drops the watcher emits one error and
 * never recovers by itself. So: an error pauses that folder's watcher and
 * retries with a rising delay until the folder can be listed again; the
 * first thing done on return is a sweep, so nothing that arrived meanwhile
 * is lost; and the sweep runs on its own clock regardless. A file the
 * watcher never heard about is picked up by the next sweep - late by minutes,
 * not lost.
 *
 * NEVER WRITES TO MMC'S FOLDERS. Files are opened for reading and nothing
 * else - not renamed, moved, deleted or marked.
 */

const FILE_NAME = /^(\d{8})\.jpe?g$/i

/** A file is read only once two looks this far apart agree on its size and mtime. */
const SETTLE_MS = 2_000
/** Retries for a file still being written or still held open by MMC. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000]
/** How long the watcher waits before trying an unreachable folder again. */
const RECONNECT_DELAYS_MS = [30_000, 60_000, 300_000]
/** A breath between documents, so a burst of stamp decisions shares the thread. */
const BETWEEN_DOCUMENTS_MS = 250

export interface MmcWatchJob {
  kind: MmcImageKind
  employeeCode: string
  /** Where the job came from, for the log. */
  via: 'watch' | 'sweep' | 'startup'
  attempt: number
}

/** What the watcher does when a job finishes, for logs and tests. */
export interface MmcJobOutcome {
  job: MmcWatchJob
  result: 'attached' | 'alreadyHad' | 'noEmployee' | 'notSettled' | 'gaveUp' | 'nothing' | 'failed'
  attached?: MmcAttachResult
  /** Documents whose stamp decision was run again. */
  decided?: number
}

/**
 * Everything the watcher touches outside itself, so a test can stand it all
 * in and drive the clock.
 */
export interface MmcWatchDeps {
  dirs: { photo?: string | undefined; signature?: string | undefined }
  watch: typeof fs.watch
  stat: (file: string) => Promise<{ size: number; mtimeMs: number }>
  readdir: (dir: string) => Promise<string[]>
  access: (dir: string) => Promise<void>
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
  findCandidateByCode: typeof employeeRepository.findMmcCandidateByCode
  listCandidatesMissingImages: typeof employeeRepository.listMmcCandidatesMissingImages
  findEmployee: typeof employeeRepository.findById
  attachMissing: typeof attachMissing
  listAwaitingSignature: typeof employeeDocumentRepository.listAwaitingSignature
  runStampDecision: typeof runStampDecision
  resolveUser: (userId: number) => Promise<AuthUser | null>
  actor: () => Promise<AuthUser>
  sweepMinutes: number
  onOutcome?: (outcome: MmcJobOutcome) => void
}

export interface MmcWatcher {
  /** Queue every file in both folders for an employee who lacks that image. */
  sweep: (via?: MmcWatchJob['via']) => Promise<number>
  /** Wait for the queue to drain - for tests and for a clean shutdown. */
  idle: () => Promise<void>
  stop: () => void
  /** For tests: what the watcher has queued and not yet finished. */
  pending: () => number
}

/* -------------------------------------------------------------------------- */
/* The real collaborators                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whose name the pickup works in: MMC_WATCH_AS, else the first active
 * administrator. Resolved once per job, so an account renamed or deactivated
 * mid-run is noticed on the next file.
 */
async function defaultActor(): Promise<AuthUser> {
  if (env.MMC_WATCH_AS) {
    const user = await userRepository.findByUsername(env.MMC_WATCH_AS)
    if (user && user.isActive) return userRepository.toAuthUser(user)
    throw new Error(`MMC_WATCH_AS names '${env.MMC_WATCH_AS}', which is not an active user`)
  }
  const admin = await userRepository.findFirstByRole(ROLES.ADMIN)
  if (!admin) throw new Error('No active administrator to attach MMC images in the name of')
  return userRepository.toAuthUser(admin)
}

async function activeUser(userId: number): Promise<AuthUser | null> {
  const user = await userRepository.findById(userId)
  return user && user.isActive ? userRepository.toAuthUser(user) : null
}

export function realDeps(): MmcWatchDeps {
  return {
    dirs: configuredDirectories(),
    watch: fs.watch,
    stat: async (file) => {
      const s = await fsp.stat(file)
      return { size: s.size, mtimeMs: s.mtimeMs }
    },
    readdir: (dir) => fsp.readdir(dir),
    access: (dir) => fsp.access(dir),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    now: () => Date.now(),
    findCandidateByCode: employeeRepository.findMmcCandidateByCode,
    listCandidatesMissingImages: employeeRepository.listMmcCandidatesMissingImages,
    findEmployee: employeeRepository.findById,
    attachMissing,
    listAwaitingSignature: employeeDocumentRepository.listAwaitingSignature,
    runStampDecision,
    resolveUser: activeUser,
    actor: defaultActor,
    sweepMinutes: env.MMC_SWEEP_MINUTES,
  }
}

/* -------------------------------------------------------------------------- */
/* The watcher                                                                 */
/* -------------------------------------------------------------------------- */

/** '00005696.jpg' -> '00005696'; anything else -> null. */
export function employeeCodeOf(fileName: string): string | null {
  const match = FILE_NAME.exec(path.basename(fileName))
  return match ? (match[1] ?? null) : null
}

const CONTEXT: RequestContext = { ipAddress: null, userAgent: 'mmc-watch' }

export function createMmcWatcher(deps: MmcWatchDeps): MmcWatcher {
  const kinds = (['photo', 'signature'] as const).filter((kind) => deps.dirs[kind])

  const queue: MmcWatchJob[] = []
  const queued = new Set<string>()
  const watchers = new Map<MmcImageKind, fs.FSWatcher>()
  const timers = new Set<unknown>()
  let draining: Promise<void> | null = null
  let stopped = false
  const idleWaiters: (() => void)[] = []

  const later = (fn: () => void, ms: number): void => {
    if (stopped) return
    const handle = deps.setTimeout(() => {
      timers.delete(handle)
      if (!stopped) fn()
    }, ms)
    timers.add(handle)
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => later(resolve, ms))

  /* ---- the queue ---------------------------------------------------------- */

  const enqueue = (job: MmcWatchJob): void => {
    if (stopped) return
    const key = `${job.kind}:${job.employeeCode}`
    // One job per file however many events it fires, and for as long as that
    // job is queued OR being handled: a second event for a file whose first
    // job is mid-way is the same file. A retry carries its own attempt count
    // and is queued by the job itself, so it is never a duplicate.
    if (job.attempt === 0 && queued.has(key)) return
    queued.add(key)
    queue.push(job)
    drain()
  }

  const drain = (): void => {
    if (draining) return
    draining = (async () => {
      try {
        while (queue.length > 0 && !stopped) {
          const job = queue.shift() as MmcWatchJob
          const key = `${job.kind}:${job.employeeCode}`
          try {
            const outcome = await handle(job)
            deps.onOutcome?.(outcome)
          } finally {
            // Released only now, so a retry scheduled by the job can take the
            // key again and a duplicate event cannot.
            queued.delete(key)
          }
        }
      } finally {
        draining = null
        for (const wake of idleWaiters.splice(0)) wake()
      }
    })()
  }

  /* ---- one file ----------------------------------------------------------- */

  /**
   * Whether the file has stopped growing: two looks SETTLE_MS apart agreeing
   * on size and mtime, and a size above zero. Null when the file has gone.
   */
  const settled = async (file: string): Promise<boolean | null> => {
    let first: { size: number; mtimeMs: number }
    try {
      first = await deps.stat(file)
    } catch {
      return null
    }
    await sleep(SETTLE_MS)
    let second: { size: number; mtimeMs: number }
    try {
      second = await deps.stat(file)
    } catch {
      return null
    }
    return second.size > 0 && second.size === first.size && second.mtimeMs === first.mtimeMs
  }

  const retryLater = (job: MmcWatchJob, why: string): MmcJobOutcome => {
    const delay = RETRY_DELAYS_MS[job.attempt]
    if (delay === undefined) {
      logger.warn(
        { kind: job.kind, employeeCode: job.employeeCode, attempts: job.attempt },
        `MMC file ${why}; giving up until the next sweep`,
      )
      return { job, result: 'gaveUp' }
    }
    later(() => enqueue({ ...job, attempt: job.attempt + 1 }), delay)
    return { job, result: 'notSettled' }
  }

  const handle = async (job: MmcWatchJob): Promise<MmcJobOutcome> => {
    const dir = deps.dirs[job.kind]
    if (!dir) return { job, result: 'nothing' }
    const file = path.join(dir, `${job.employeeCode}.jpg`)

    try {
      const ready = await settled(file)
      if (ready === null) return { job, result: 'nothing' }
      if (!ready) return retryLater(job, 'is still being written')

      const candidate = await deps.findCandidateByCode(job.employeeCode)
      if (!candidate) {
        // Not on the books: not created yet, archived, or left. When they are
        // created the creation hook looks in the folder; nothing to do now.
        return { job, result: 'noEmployee' }
      }
      const already = job.kind === 'photo' ? candidate.hasPhoto : candidate.hasSignature
      if (already) return { job, result: 'alreadyHad' }

      const employee = await deps.findEmployee(candidate.employeeId)
      if (!employee) return { job, result: 'noEmployee' }

      const actor = await deps.actor()
      // The watcher's own folders, not whatever the environment says now: the
      // two are the same in production and must be the same here.
      const attached = await deps.attachMissing(employee, actor, CONTEXT, { dirs: deps.dirs })
      const took = attached[job.kind]

      if (took === 'unreadable') {
        // MMC still has it open, or it is not yet a whole image. Try again.
        return { ...retryLater(job, 'could not be read'), attached }
      }
      if (took !== 'attached') {
        return { job, result: took === 'alreadyHad' ? 'alreadyHad' : 'nothing', attached }
      }

      logger.info(
        { kind: job.kind, employeeCode: job.employeeCode, via: job.via },
        'MMC image attached',
      )

      // Now that the image is on file, every document of theirs still waiting
      // for a signature is decided about again - one at a time, with a breath
      // between, so sixty-five signatures arriving at once is a few quiet
      // minutes of work rather than a spike.
      const waiting = await deps.listAwaitingSignature(candidate.employeeId)
      let decided = 0
      for (const document of waiting) {
        if (stopped) break
        const uploader = document.uploadedBy ? await deps.resolveUser(document.uploadedBy) : null
        await deps.runStampDecision(document.documentId, uploader ?? actor, CONTEXT)
        decided += 1
        await sleep(BETWEEN_DOCUMENTS_MS)
      }

      return { job, result: 'attached', attached, decided }
    } catch (error) {
      logger.error(
        { err: error, kind: job.kind, employeeCode: job.employeeCode },
        `MMC pickup failed: ${describeError(error)}`,
      )
      return { job, result: 'failed' }
    }
  }

  /* ---- the sweep ---------------------------------------------------------- */

  const sweep = async (via: MmcWatchJob['via'] = 'sweep'): Promise<number> => {
    if (stopped) return 0
    let queuedNow = 0
    try {
      const listings = new Map<MmcImageKind, Set<string>>()
      for (const kind of kinds) {
        const dir = deps.dirs[kind] as string
        try {
          const names = await deps.readdir(dir)
          const codes = new Set<string>()
          for (const name of names) {
            const code = employeeCodeOf(name)
            if (code) codes.add(code)
          }
          listings.set(kind, codes)
        } catch (error) {
          noteUnreachable(kind, dir, error)
        }
      }
      if (listings.size === 0) return 0

      const missing = await deps.listCandidatesMissingImages()
      for (const candidate of missing) {
        for (const kind of kinds) {
          const has = kind === 'photo' ? candidate.hasPhoto : candidate.hasSignature
          if (has) continue
          if (!listings.get(kind)?.has(candidate.employeeCode)) continue
          enqueue({ kind, employeeCode: candidate.employeeCode, via, attempt: 0 })
          queuedNow += 1
        }
      }
      if (queuedNow > 0) {
        logger.info({ queued: queuedNow, via }, 'MMC sweep found files to take in')
      }
    } catch (error) {
      logger.error({ err: error }, `MMC sweep failed: ${describeError(error)}`)
    }
    return queuedNow
  }

  const scheduleSweep = (): void => {
    if (deps.sweepMinutes <= 0) return
    later(() => {
      void sweep('sweep').finally(scheduleSweep)
    }, deps.sweepMinutes * 60_000)
  }

  /* ---- the ears ----------------------------------------------------------- */

  const unreachable = new Set<MmcImageKind>()

  const noteUnreachable = (kind: MmcImageKind, dir: string, error: unknown): void => {
    if (unreachable.has(kind)) return
    unreachable.add(kind)
    logger.warn(
      { kind, dir, err: error },
      'MMC folder is not reachable; watching it is paused and will resume when it is back',
    )
  }

  const startWatching = (kind: MmcImageKind, reconnectAttempt = 0): void => {
    if (stopped) return
    const dir = deps.dirs[kind] as string

    void deps
      .access(dir)
      .then(() => {
        const wasUnreachable = unreachable.delete(kind)
        let watcher: fs.FSWatcher
        try {
          watcher = deps.watch(dir, { persistent: false }, (_event, fileName) => {
            const code = fileName ? employeeCodeOf(String(fileName)) : null
            if (code) enqueue({ kind, employeeCode: code, via: 'watch', attempt: 0 })
          })
        } catch (error) {
          noteUnreachable(kind, dir, error)
          later(
            () => startWatching(kind, reconnectAttempt + 1),
            RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
              300_000,
          )
          return
        }
        watcher.on('error', (error) => {
          watchers.delete(kind)
          try {
            watcher.close()
          } catch {
            // Already gone.
          }
          noteUnreachable(kind, dir, error)
          later(() => startWatching(kind, 1), RECONNECT_DELAYS_MS[0] ?? 30_000)
        })
        watchers.set(kind, watcher)
        if (wasUnreachable) {
          logger.info({ kind, dir }, 'MMC folder is reachable again; sweeping for what arrived')
          void sweep('sweep')
        }
      })
      .catch((error: unknown) => {
        noteUnreachable(kind, dir, error)
        later(
          () => startWatching(kind, reconnectAttempt + 1),
          RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
            300_000,
        )
      })
  }

  for (const kind of kinds) startWatching(kind)
  scheduleSweep()

  return {
    sweep,
    idle: () =>
      draining ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve(),
    pending: () => queue.length,
    stop: () => {
      stopped = true
      for (const watcher of watchers.values()) {
        try {
          watcher.close()
        } catch {
          // Already gone.
        }
      }
      watchers.clear()
      for (const handle of timers) deps.clearTimeout(handle)
      timers.clear()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle, for server.ts                                                    */
/* -------------------------------------------------------------------------- */

let running: MmcWatcher | null = null

/** Starts the pickup when a folder is configured and MMC_WATCH is on. */
export function startMmcWatch(): void {
  if (running) return
  const dirs = configuredDirectories()
  if (!dirs.photo && !dirs.signature) return
  if (!env.MMC_WATCH) {
    logger.info('MMC_WATCH is off; MMC images are attached only at creation and by hand')
    return
  }
  running = createMmcWatcher(realDeps())
  logger.info(
    {
      photo: dirs.photo ?? null,
      signature: dirs.signature ?? null,
      sweepMinutes: env.MMC_SWEEP_MINUTES,
    },
    'Watching the MMC folders for photographs and signatures',
  )
  // Whatever arrived while the server was down.
  void running.sweep('startup')
}

export function stopMmcWatch(): void {
  running?.stop()
  running = null
}
