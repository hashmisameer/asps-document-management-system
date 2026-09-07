import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { EMPLOYMENT_STATUSES, type EmployeeProfile } from '@asps-dms/shared'
import {
  bundleFileName,
  renderDocumentBundle,
  type BundleEntry,
  type DocumentBundle,
} from '../../src/services/documentBundle.service.js'

/**
 * Every document an employee has sent in, bound into one PDF.
 *
 * The documents here are real files - a two-page PDF, a JPEG, a TIFF - built
 * and then merged, so what is asserted is that the pages actually arrive
 * rather than that a function was called. The text is read back out with
 * pdf.js, the same way the printed form is checked.
 */

const META = { generatedAt: new Date(2026, 8, 7, 10, 30), generatedBy: 'Sameer Hashmi' }

function employee(overrides: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    employeeId: 1,
    employeeCode: 'EMP-1010',
    employeeName: 'BHAGWAN SINGH',
    joiningDate: '2026-01-12',
    department: 'JACKET FRONT',
    designation: 'ASSTT.OPERATER',
    phoneNumber: null,
    email: null,
    address: null,
    dateOfBirth: null,
    gender: null,
    postAppliedFor: null,
    categoryOfWorkmen: null,
    aadhaarNumber: null,
    panNumber: null,
    uanNumber: null,
    esiNumber: null,
    appointmentLetterDate: null,
    hasPhoto: false,
    photoUpdatedAt: null,
    employmentStatus: EMPLOYMENT_STATUSES.ACTIVE,
    resignationDate: null,
    lastWorkingDate: null,
    exitReason: null,
    exitNotes: null,
    isActive: true,
    createdAt: '2026-01-12T05:00:00.000Z',
    updatedAt: '2026-01-12T05:00:00.000Z',
    counts: { total: 10, completed: 3, pending: 7, overdue: 0, signatureReviewRequired: 0 },
    hasSignature: true,
    signatureUpdatedAt: null,
    ...overrides,
  }
}

/** A real PDF with the given words, one page each. */
async function pdfOf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  for (const text of pages) {
    const page = pdf.addPage([595.28, 841.89])
    page.drawText(text, { x: 60, y: 700, font, size: 18 })
  }
  return Buffer.from(await pdf.save())
}

/** A real image, in whichever format is asked for. */
async function imageOf(format: 'jpeg' | 'png' | 'tiff' | 'webp'): Promise<Buffer> {
  const canvas = sharp({
    create: { width: 400, height: 600, channels: 3, background: { r: 220, g: 220, b: 220 } },
  })
  return format === 'jpeg'
    ? canvas.jpeg().toBuffer()
    : format === 'png'
      ? canvas.png().toBuffer()
      : format === 'tiff'
        ? canvas.tiff().toBuffer()
        : canvas.webp().toBuffer()
}

function entry(overrides: Partial<BundleEntry> & { file: BundleEntry['file'] }): BundleEntry {
  return {
    documentName: 'Appointment Letter',
    isMandatory: true,
    uploadedAt: '2026-01-18T09:15:00.000Z',
    uploadedByName: 'Pragati Dixit',
    ...overrides,
  }
}

async function bundleOf(
  included: BundleEntry[],
  pending: DocumentBundle['pending'] = [],
): Promise<Buffer> {
  return renderDocumentBundle({ employee: employee(), included, pending }, META)
}

/** Reads the words back out, one string per page. */
async function pagesOf(pdf: Buffer): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const parsed = await getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise

  try {
    const pages: string[] = []
    for (let n = 1; n <= parsed.numPages; n += 1) {
      const page = await parsed.getPage(n)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return pages
  } finally {
    await parsed.destroy()
  }
}

describe('the file name', () => {
  it('is the employee code and name', () => {
    expect(bundleFileName({ employeeCode: 'EMP-1010', employeeName: 'BHAGWAN SINGH' })).toBe(
      'EMP-1010_BHAGWAN_SINGH_DOCUMENTS.pdf',
    )
  })

  it('reduces anything a header or a file system would argue about', () => {
    expect(bundleFileName({ employeeCode: 'EMP/22', employeeName: 'Ram "Raju" Yadav' })).toBe(
      'EMP_22_RAM_RAJU_YADAV_DOCUMENTS.pdf',
    )
  })
})

describe('the cover', () => {
  it('says who the file is about', async () => {
    const pdf = await bundleOf([
      entry({ file: { read: () => pdfOf(['THE LETTER']), mimeType: 'application/pdf', isSigned: false } }),
    ])

    const [cover = ''] = await pagesOf(pdf)
    expect(cover).toContain('ASPS International LLP')
    expect(cover).toContain('EMP-1010')
    expect(cover).toContain('BHAGWAN SINGH')
    expect(cover).toContain('JACKET FRONT')
    expect(cover).toContain('12/01/2026')
    expect(cover).toContain('Prepared 07/09/2026 10:30 by Sameer Hashmi')
  })

  it('names what is in the file and what is still missing', async () => {
    // A bundle that lists only what it contains reads as complete, and
    // somebody receiving two documents cannot tell the office holds two of ten.
    const pdf = await bundleOf(
      [
        entry({
          documentName: 'Appointment Letter',
          file: { read: () => pdfOf(['A']), mimeType: 'application/pdf', isSigned: false },
        }),
        entry({
          documentName: 'PAN Card',
          file: { read: () => imageOf('jpeg'), mimeType: 'image/jpeg', isSigned: false },
        }),
      ],
      [
        { documentName: 'Aadhaar Card', isMandatory: true },
        { documentName: 'PF Form', isMandatory: false },
      ],
    )

    const [cover = ''] = await pagesOf(pdf)
    expect(cover).toContain('IN THIS FILE (2)')
    expect(cover).toContain('NOT YET RECEIVED (2)')
    expect(cover).toContain('Aadhaar Card')
    expect(cover).toContain('(mandatory)')
    expect(cover).toContain('2 of 4 documents are in this file.')
  })
})

describe('what goes into the bundle', () => {
  it('puts a separator page before each document, in the order given', async () => {
    // The order is the checklist's own - the service reads them that way - and
    // the separator is what answers 'where does this one start'.
    const pdf = await bundleOf([
      entry({
        documentName: 'Appointment Letter',
        file: { read: () => pdfOf(['LETTER PAGE']), mimeType: 'application/pdf', isSigned: false },
      }),
      entry({
        documentName: 'Service Card',
        uploadedAt: '2026-02-01T09:00:00.000Z',
        file: { read: () => pdfOf(['CARD PAGE']), mimeType: 'application/pdf', isSigned: false },
      }),
    ])

    const pages = await pagesOf(pdf)

    expect(pages).toHaveLength(5) // cover + (separator + page) x 2
    expect(pages[1]).toContain('Appointment Letter')
    expect(pages[1]).toContain('Document 1 of 2')
    expect(pages[1]).toContain('Received 18/01/2026')
    expect(pages[2]).toContain('LETTER PAGE')
    expect(pages[3]).toContain('Service Card')
    expect(pages[3]).toContain('Document 2 of 2')
    expect(pages[3]).toContain('Received 01/02/2026')
    expect(pages[4]).toContain('CARD PAGE')
  })

  it('keeps every page of a document that has several', async () => {
    const pdf = await bundleOf([
      entry({ file: { read: () => pdfOf(['ONE', 'TWO', 'THREE']), mimeType: 'application/pdf', isSigned: false } }),
    ])

    const pages = await pagesOf(pdf)
    expect(pages).toHaveLength(5)
    expect(pages[2]).toContain('ONE')
    expect(pages[3]).toContain('TWO')
    expect(pages[4]).toContain('THREE')
  })

  it('says which copy it took', async () => {
    const signed = await bundleOf([
      entry({ file: { read: () => pdfOf(['SIGNED']), mimeType: 'application/pdf', isSigned: true } }),
    ])
    const original = await bundleOf([
      entry({ file: { read: () => pdfOf(['PLAIN']), mimeType: 'application/pdf', isSigned: false } }),
    ])

    // A signed document and the original it was made from are different pieces
    // of paper.
    expect((await pagesOf(signed))[1]).toContain('Signed copy')
    expect((await pagesOf(original))[1]).toContain('As it was uploaded')
  })

  it('turns a photograph into a page', async () => {
    const pdf = await bundleOf([
      entry({ file: { read: () => imageOf('jpeg'), mimeType: 'image/jpeg', isSigned: false } }),
    ])

    const parsed = await PDFDocument.load(pdf)
    expect(parsed.getPageCount()).toBe(3)

    // Fitted to A4 rather than given a page of its own size, so a bundle of a
    // form and three phone photographs prints as one stack of paper.
    const page = parsed.getPage(2)
    expect(Math.round(page.getWidth())).toBe(595)
    expect(Math.round(page.getHeight())).toBe(842)
  })

  it('converts the image formats a PDF cannot hold', async () => {
    // WEBP and TIFF are both accepted uploads and neither can be embedded.
    for (const format of ['tiff', 'webp', 'png'] as const) {
      const pdf = await bundleOf([
        entry({ file: { read: () => imageOf(format), mimeType: `image/${format}`, isSigned: false } }),
      ])

      const parsed = await PDFDocument.load(pdf)
      expect(parsed.getPageCount(), format).toBe(3)
    }
  })

  it('accounts for a document it cannot read rather than dropping it', async () => {
    // A file the store has lost, or one that is not really a PDF. Silently
    // returning nine of ten is how somebody comes to believe a document was
    // never collected.
    const pdf = await bundleOf([
      entry({
        documentName: 'Bio Data Form',
        file: { read: async () => Buffer.from('not a pdf at all'), mimeType: 'application/pdf', isSigned: false },
      }),
      entry({
        documentName: 'Service Card',
        file: { read: () => pdfOf(['GOOD ONE']), mimeType: 'application/pdf', isSigned: false },
      }),
    ])

    const pages = await pagesOf(pdf)
    expect(pages[1]).toContain('Bio Data Form')
    expect(pages[2]).toContain('could not be read')
    // And the one after it is unaffected.
    expect(pages[3]).toContain('Service Card')
    expect(pages[4]).toContain('GOOD ONE')
  })

  it('says so on the separator when the type cannot be included at all', async () => {
    const pdf = await bundleOf([
      entry({ file: { read: async () => Buffer.from('zip'), mimeType: 'application/zip', isSigned: false } }),
    ])

    const pages = await pagesOf(pdf)
    expect(pages).toHaveLength(2)
    expect(pages[1]).toContain('application/zip')
  })
})

describe('the pages this adds, and the ones it does not touch', () => {
  it('footers its own pages only', async () => {
    // Stamping a page number across somebody's scanned card would change what
    // the office is holding out as a copy of it.
    const pdf = await bundleOf([
      entry({ file: { read: () => pdfOf(['SCANNED CARD']), mimeType: 'application/pdf', isSigned: false } }),
    ])

    const pages = await pagesOf(pdf)

    expect(pages[0]).toContain('Generated 07/09/2026 10:30 by Sameer Hashmi')
    expect(pages[1]).toContain('Page 2 of 3')
    expect(pages[2]).toContain('SCANNED CARD')
    expect(pages[2]).not.toContain('Page 3 of 3')
    expect(pages[2]).not.toContain('Sameer Hashmi')
  })
})
