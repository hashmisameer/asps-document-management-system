import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How an image is OPENED for OCR, with sharp and Tesseract both stood in for.
 *
 * documentText.test.ts reads real cards. What it cannot pin is the option
 * that made the TIFF case fail one time in five under load - sharp's default
 * sequential read, which the TIFF loader cannot serve when normalise() and
 * sharpen() read lines out of order across busy threads. This checks the
 * option is passed, every time an uploaded image is opened.
 */

const spies = vi.hoisted(() => ({
  sharpCalls: [] as { input: unknown; options: unknown }[],
  recognize: vi.fn(),
}))

vi.mock('sharp', () => {
  const chain = {
    metadata: async () => ({ width: 1200, height: 760 }),
    rotate() {
      return this
    },
    resize() {
      return this
    },
    greyscale() {
      return this
    },
    normalise() {
      return this
    },
    sharpen() {
      return this
    },
    clahe() {
      return this
    },
    png() {
      return this
    },
    toBuffer: async () => Buffer.from('prepared-png'),
  }
  const sharp = (input: unknown, options: unknown) => {
    spies.sharpCalls.push({ input, options })
    return chain
  }
  return { default: sharp }
})

vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    setParameters: async () => undefined,
    recognize: spies.recognize,
    terminate: async () => undefined,
  }),
}))

const { extractText, closeOcrWorker } = await import('../../src/services/documentText.service.js')

beforeEach(() => {
  spies.sharpCalls.length = 0
  spies.recognize.mockResolvedValue({ data: { text: 'BHAGWAN SINGH', confidence: 90 } })
})

describe('opening an image for OCR', () => {
  it('asks sharp for random access, never the sequential default', async () => {
    const tiff = Buffer.from('a tiff, as far as this test is concerned')

    await extractText(tiff, 'image/tiff', (text) => text.includes('SINGH'))
    await closeOcrWorker()

    // Once for metadata and once for the pipeline, at least.
    expect(spies.sharpCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of spies.sharpCalls) {
      expect(call.input).toBe(tiff)
      expect(call.options).toEqual({ failOn: 'none', sequentialRead: false })
    }
  })

  it('hands Tesseract the prepared PNG, not the file that arrived', async () => {
    const tiff = Buffer.from('a tiff, as far as this test is concerned')

    await extractText(tiff, 'image/tiff', (text) => text.includes('SINGH'))
    await closeOcrWorker()

    const handed = spies.recognize.mock.calls[0]?.[0] as Buffer
    expect(handed.toString()).toBe('prepared-png')
  })
})
