import { EventEmitter } from 'node:events'
import type fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type AuthUser } from '@asps-dms/shared'
import {
  createMmcWatcher,
  employeeCodeOf,
  type MmcJobOutcome,
  type MmcWatchDeps,
} from '../../src/services/mmcWatch.service.js'

/**
 * The MMC pickup, with the folders, the clock and everything it calls stood
 * in - so a file can 'appear', a folder can 'go away', and hours can pass
 * in a millisecond.
 *
 * What is pinned: a file heard is taken in and the stamp decision run again
 * for that employee's waiting documents, in the uploader's name; a file for
 * nobody, or for somebody who already has the image, does nothing; a file
 * still being written is waited for and then given up on; a burst of events
 * is one job; the sweep queues exactly the files for employees who lack
 * them; and a folder that goes away pauses the watcher and sweeps on return.
 */

const admin: AuthUser = {
  userId: 1,
  username: 'admin',
  fullName: 'Administrator',
  role: ROLES.ADMIN,
  mustChangePassword: false,
}
const uploader: AuthUser = { ...admin, userId: 9, username: 'hr.original', role: ROLES.HR }

/** A fake folder pair: names in each, sizes per file, and the watch emitters. */
class FakeFolders {
  files = new Map<string, { size: number; mtimeMs: number }>()
  emitters = new Map<string, EventEmitter>()
  unreachable = new Set<string>()
  timers: { at: number; fn: () => void; handle: object }[] = []
  clock = 1_000_000

  readonly dirs = { photo: 'G:/MMC/Image', signature: 'G:/MMC/Signature' }

  put(dir: string, name: string, size = 4096): void {
    this.files.set(`${dir}/${name}`, { size, mtimeMs: this.clock })
  }

  grow(dir: string, name: string, size: number): void {
    this.files.set(`${dir}/${name}`, { size, mtimeMs: this.clock })
  }

  /** What fs.watch would tell us. */
  appear(dir: string, name: string): void {
    this.emitters.get(dir)?.emit('change', 'rename', name)
  }

  deps(overrides: Partial<MmcWatchDeps> = {}): MmcWatchDeps {
    return {
      dirs: this.dirs,
      watch: ((dir: string, _options: unknown, listener: (event: string, name: string) => void) => {
        const emitter = new EventEmitter()
        emitter.on('change', listener)
        this.emitters.set(dir, emitter)
        const watcher = Object.assign(emitter, { close: () => this.emitters.delete(dir) })
        return watcher as unknown as fs.FSWatcher
      }) as unknown as typeof fs.watch,
      stat: async (file) => {
        const entry = this.files.get(file.replace(/\\/g, '/'))
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return entry
      },
      readdir: async (dir) => {
        if (this.unreachable.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return [...this.files.keys()]
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => f.slice(dir.length + 1))
      },
      access: async (dir) => {
        if (this.unreachable.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      setTimeout: (fn, ms) => {
        const handle = {}
        this.timers.push({ at: this.clock + ms, fn, handle })
        return handle
      },
      clearTimeout: (handle) => {
        this.timers = this.timers.filter((t) => t.handle !== handle)
      },
      now: () => this.clock,
      findCandidateByCode: vi.fn(),
      listCandidatesMissingImages: vi.fn(async () => []),
      findEmployee: vi.fn(
        async (id: number) => ({ employeeId: id, employeeCode: '00006100' }) as never,
      ),
      attachMissing: vi.fn(async () => ({ photo: 'alreadyHad', signature: 'attached' }) as never),
      listAwaitingSignature: vi.fn(async () => []),
      runStampDecision: vi.fn(async () => null),
      resolveUser: vi.fn(async (id: number) => (id === 9 ? uploader : null)),
      actor: async () => admin,
      sweepMinutes: 10,
      ...overrides,
    }
  }

  /**
   * Advance the clock, firing every timer that falls due, and let promises
   * settle. Timers are re-scanned after every flush, because a handler that
   * is mid-await registers its next timer only once the microtasks run.
   */
  async advance(ms: number): Promise<void> {
    const until = this.clock + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.clock = due.at
      this.timers = this.timers.filter((t) => t !== due)
      due.fn()
    }
    this.clock = until
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let folders: FakeFolders
let outcomes: MmcJobOutcome[]

beforeEach(async () => {
  folders = new FakeFolders()
  outcomes = []
  await flush()
})

const waiting = (deps: MmcWatchDeps, code = '00006100') => {
  ;(deps.findCandidateByCode as ReturnType<typeof vi.fn>).mockResolvedValue({
    employeeId: 42,
    employeeCode: code,
    hasPhoto: true,
    hasSignature: false,
  })
}

describe('a file name', () => {
  it('is an employee code only when it is eight digits and a jpg', () => {
    expect(employeeCodeOf('00005696.jpg')).toBe('00005696')
    expect(employeeCodeOf('00005696.JPG')).toBe('00005696')
    expect(employeeCodeOf('00005696.jpeg')).toBe('00005696')
    expect(employeeCodeOf('5696.jpg')).toBeNull()
    expect(employeeCodeOf('00005696.png')).toBeNull()
    expect(employeeCodeOf('Thumbs.db')).toBeNull()
    expect(employeeCodeOf('00005696.jpg.tmp')).toBeNull()
  })
})

describe('a signature that appears', () => {
  it('is taken in, and the stamp decision run again for the waiting documents in their uploaders’ names', async () => {
    const deps = folders.deps({
      onOutcome: (o) => outcomes.push(o),
      listAwaitingSignature: vi.fn(async () => [
        { documentId: 501, uploadedBy: 9 },
        { documentId: 502, uploadedBy: 404 },
      ]),
    })
    waiting(deps)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00006100.jpg')
    folders.appear(folders.dirs.signature, '00006100.jpg')
    await folders.advance(3_000)
    await watcher.idle()

    expect(deps.attachMissing).toHaveBeenCalledTimes(1)
    expect(outcomes.at(-1)).toMatchObject({ result: 'attached', decided: 2 })
    // The first document in its uploader's name; the second's uploader is
    // gone, so the pickup's own account signs for the HR box.
    expect(deps.runStampDecision).toHaveBeenCalledWith(501, uploader, expect.anything())
    expect(deps.runStampDecision).toHaveBeenCalledWith(502, admin, expect.anything())
    watcher.stop()
  })

  it('is one job however many events the folder fires for it', async () => {
    const deps = folders.deps({ onOutcome: (o) => outcomes.push(o) })
    waiting(deps)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00006100.jpg')
    for (let i = 0; i < 5; i += 1) folders.appear(folders.dirs.signature, '00006100.jpg')
    await folders.advance(3_000)
    await watcher.idle()

    expect(deps.attachMissing).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('does nothing for a code that is not on the books', async () => {
    const deps = folders.deps({ onOutcome: (o) => outcomes.push(o) })
    ;(deps.findCandidateByCode as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00009999.jpg')
    folders.appear(folders.dirs.signature, '00009999.jpg')
    await folders.advance(3_000)
    await watcher.idle()

    expect(outcomes.at(-1)?.result).toBe('noEmployee')
    expect(deps.attachMissing).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('leaves alone an employee who already has that image - never replaces', async () => {
    const deps = folders.deps({ onOutcome: (o) => outcomes.push(o) })
    ;(deps.findCandidateByCode as ReturnType<typeof vi.fn>).mockResolvedValue({
      employeeId: 42,
      employeeCode: '00006100',
      hasPhoto: true,
      hasSignature: true,
    })
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00006100.jpg')
    folders.appear(folders.dirs.signature, '00006100.jpg')
    await folders.advance(3_000)
    await watcher.idle()

    expect(outcomes.at(-1)?.result).toBe('alreadyHad')
    expect(deps.attachMissing).not.toHaveBeenCalled()
    expect(deps.runStampDecision).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('ignores files that are not an employee image', async () => {
    const deps = folders.deps({ onOutcome: (o) => outcomes.push(o) })
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.appear(folders.dirs.signature, 'Thumbs.db')
    folders.appear(folders.dirs.signature, '00006100.jpg.tmp')
    await folders.advance(3_000)
    await watcher.idle()

    expect(outcomes).toEqual([])
    watcher.stop()
  })
})

describe('a file still being written', () => {
  it('is waited for until it stops growing', async () => {
    const deps = folders.deps({ onOutcome: (o) => outcomes.push(o) })
    waiting(deps)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00006100.jpg', 1024)
    folders.appear(folders.dirs.signature, '00006100.jpg')
    // Still growing at the second look: not read, retried five seconds on.
    await folders.advance(1_000)
    folders.grow(folders.dirs.signature, '00006100.jpg', 2048)
    await folders.advance(2_000)
    await watcher.idle()
    expect(outcomes.map((o) => o.result)).toEqual(['notSettled'])
    expect(deps.attachMissing).not.toHaveBeenCalled()

    // Finished by the retry: taken in.
    await folders.advance(5_000 + 3_000)
    await watcher.idle()
    expect(outcomes.map((o) => o.result)).toEqual(['notSettled', 'attached'])
    watcher.stop()
  })

  it('gives up after the retries and leaves it to the sweep', async () => {
    // A file that is a byte bigger every time it is looked at: never settles.
    let size = 0
    const deps = folders.deps({
      onOutcome: (o) => outcomes.push(o),
      stat: async () => ({ size: (size += 1), mtimeMs: folders.clock }),
    })
    waiting(deps)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.appear(folders.dirs.signature, '00006100.jpg')
    // Long enough for every retry in the ladder to have come and gone.
    await folders.advance(20 * 60_000)
    await watcher.idle()

    expect(outcomes.map((o) => o.result)).toEqual([
      'notSettled',
      'notSettled',
      'notSettled',
      'notSettled',
      'gaveUp',
    ])
    expect(deps.attachMissing).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('treats a file MMC still has open the same way', async () => {
    const deps = folders.deps({
      onOutcome: (o) => outcomes.push(o),
      attachMissing: vi.fn(async () => ({ photo: 'alreadyHad', signature: 'unreadable' }) as never),
    })
    waiting(deps)
    const watcher = createMmcWatcher(deps)
    await flush()

    folders.put(folders.dirs.signature, '00006100.jpg')
    folders.appear(folders.dirs.signature, '00006100.jpg')
    await folders.advance(3_000)
    await watcher.idle()

    expect(outcomes.at(-1)?.result).toBe('notSettled')
    expect(deps.runStampDecision).not.toHaveBeenCalled()
    watcher.stop()
  })
})

describe('the sweep', () => {
  it('queues exactly the files for employees who lack that image', async () => {
    const deps = folders.deps({
      onOutcome: (o) => outcomes.push(o),
      listCandidatesMissingImages: vi.fn(async () => [
        { employeeId: 1, employeeCode: '00000001', hasPhoto: false, hasSignature: false },
        { employeeId: 2, employeeCode: '00000002', hasPhoto: true, hasSignature: false },
        { employeeId: 3, employeeCode: '00000003', hasPhoto: false, hasSignature: true },
      ]),
      findCandidateByCode: vi.fn(async (code: string) => ({
        employeeId: Number(code),
        employeeCode: code,
        hasPhoto: code !== '00000001' && code !== '00000003',
        hasSignature: code === '00000003',
      })),
    })
    // In the folders: 1's photo, 2's signature, 3's signature (which 3 has), nothing for 1's signature.
    folders.put(folders.dirs.photo, '00000001.jpg')
    folders.put(folders.dirs.signature, '00000002.jpg')
    folders.put(folders.dirs.signature, '00000003.jpg')
    const watcher = createMmcWatcher(deps)
    await flush()

    const queued = await watcher.sweep('startup')
    // Two files, settled one after the other.
    await folders.advance(10_000)
    await watcher.idle()

    expect(queued).toBe(2)
    expect(outcomes.map((o) => [o.job.kind, o.job.employeeCode, o.job.via])).toEqual([
      ['photo', '00000001', 'startup'],
      ['signature', '00000002', 'startup'],
    ])
    watcher.stop()
  })

  it('runs on its own clock', async () => {
    const list = vi.fn(async () => [])
    const watcher = createMmcWatcher(
      folders.deps({ listCandidatesMissingImages: list, sweepMinutes: 10 }),
    )
    await flush()

    await folders.advance(10 * 60_000 + 10)
    expect(list).toHaveBeenCalledTimes(1)
    await folders.advance(10 * 60_000)
    expect(list).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('can be switched off', async () => {
    const list = vi.fn(async () => [])
    const watcher = createMmcWatcher(
      folders.deps({ listCandidatesMissingImages: list, sweepMinutes: 0 }),
    )
    await flush()

    await folders.advance(60 * 60_000)
    expect(list).not.toHaveBeenCalled()
    watcher.stop()
  })
})

describe('a folder that goes away', () => {
  it('pauses that watcher, and sweeps when the folder is back', async () => {
    folders.unreachable.add(folders.dirs.signature)
    const list = vi.fn(async () => [])
    const deps = folders.deps({ listCandidatesMissingImages: list, sweepMinutes: 0 })
    const watcher = createMmcWatcher(deps)
    await flush()

    // The photo folder is watched; the signature folder is not.
    expect(folders.emitters.has(folders.dirs.photo)).toBe(true)
    expect(folders.emitters.has(folders.dirs.signature)).toBe(false)

    // Back after a while: watched again, and swept first.
    folders.unreachable.delete(folders.dirs.signature)
    await folders.advance(30_000 + 10)
    expect(folders.emitters.has(folders.dirs.signature)).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('recovers from a watcher error the same way', async () => {
    const list = vi.fn(async () => [])
    const watcher = createMmcWatcher(
      folders.deps({ listCandidatesMissingImages: list, sweepMinutes: 0 }),
    )
    await flush()

    folders.emitters
      .get(folders.dirs.photo)
      ?.emit('error', new Error('network name no longer available'))
    await flush()
    expect(folders.emitters.has(folders.dirs.photo)).toBe(false)

    await folders.advance(30_000 + 10)
    expect(folders.emitters.has(folders.dirs.photo)).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    watcher.stop()
  })
})

describe('stopping', () => {
  it('closes the ears and drops every timer', async () => {
    const watcher = createMmcWatcher(folders.deps())
    await flush()
    expect(folders.emitters.size).toBe(2)

    watcher.stop()
    expect(folders.emitters.size).toBe(0)
    expect(folders.timers).toEqual([])
  })
})
