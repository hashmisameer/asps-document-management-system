import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  EMPLOYMENT_STATUSES,
  EXIT_REASONS,
  SIGNATURE_STATUS,
  type EmployeeDocument,
  type EmployeeProfile,
} from '@asps-dms/shared'
import {
  bulkFileName,
  checklistStatus,
  formFileName,
  renderEmployeeFile,
  renderEmployeeForms,
  type EmployeeFileData,
  type EmployeeFormData,
} from '../../src/services/employeeForm.service.js'
import type { DocumentEntry } from '../../src/services/documentPages.service.js'

/**
 * The printed employee form.
 *
 * Asserted by READING THE TEXT BACK OUT of the generated PDF with pdf.js -
 * the same library the identity check reads uploaded documents with - rather
 * than by counting bytes. What matters about this file is what a person holding
 * the paper can see on it, and that is the only way to check it.
 *
 * The four cases the office actually produces are all here: a complete record, a
 * half-filled one, somebody who has left, and a print of twenty at once.
 */

const GENERATED_AT = new Date(2026, 8, 3, 14, 20)
const META = { generatedAt: GENERATED_AT, generatedBy: 'Sameer Hashmi' }

function employee(overrides: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    employeeId: 1,
    employeeCode: 'EMP-1010',
    employeeName: 'BHAGWAN SINGH',
    joiningDate: '2026-01-12',
    department: 'JACKET FRONT',
    designation: 'ASSTT.OPERATER',
    phoneNumber: '9812345670',
    email: 'bhagwan@example.com',
    address: '112 Sector 8, Faridabad, Haryana 121006',
    dateOfBirth: '1991-04-07',
    gender: 'Male',
    postAppliedFor: 'ASSTT.OPERATER',
    categoryOfWorkmen: 'Skilled',
    aadhaarNumber: '123456789012',
    // An invented PAN, here only so the test below can prove it never
    // reaches the printed page.
    panNumber: 'ABCDE1234F', // asps-dms:allow-secret
    uanNumber: '100200300400',
    esiNumber: '3100200300400',
    appointmentLetterDate: '2026-01-12',
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
    counts: { total: 10, completed: 6, pending: 4, overdue: 2, signatureReviewRequired: 0 },
    hasSignature: true,
    signatureUpdatedAt: '2026-01-20T05:00:00.000Z',
    ...overrides,
  }
}

function document(
  documentId: number,
  overrides: Partial<EmployeeDocument> = {},
): EmployeeDocument {
  return {
    documentId,
    employeeId: 1,
    employeeCode: 'EMP-1010',
    employeeName: 'BHAGWAN SINGH',
    documentTypeId: documentId,
    documentName: `Document ${documentId}`,
    isMandatory: true,
    requiresSignature: false,
    originalFileName: null,
    fileSizeBytes: null,
    mimeType: null,
    pageCount: null,
    hasProcessedFile: false,
    status: DOCUMENT_STATUS.PENDING,
    signatureStatus: SIGNATURE_STATUS.NOT_REQUIRED,
    notRequiredAt: null,
    notRequiredByName: null,
    dueDate: '2026-01-22',
    deadlineUnit: 'DAY' as const,
    deadlineState: DEADLINE_STATE.NOT_DUE,
    daysRemaining: 5,
    identityCheck: null,
    uploadedByName: null,
    uploadedAt: null,
    verifiedByName: null,
    verifiedAt: null,
    rejectionReason: null,
    createdAt: '2026-01-12T05:00:00.000Z',
    updatedAt: '2026-01-12T05:00:00.000Z',
    ...overrides,
  }
}

/** The ten types an employee's checklist is created with, six of them in. */
function fullChecklist(): EmployeeDocument[] {
  const names = [
    'Appointment Letter',
    'Bio Data Form',
    'Aadhaar Card',
    'PAN Card',
    'PF Form',
    'ESIC Form',
    'Service Card',
    'Payment of Gratuity',
    'Form No. 16',
    'Confirmation Letter',
  ]

  return names.map((documentName, index) =>
    document(index + 1, {
      documentName,
      isMandatory: index < 6,
      ...(index < 6
        ? {
            status: DOCUMENT_STATUS.VERIFIED,
            deadlineState: DEADLINE_STATE.COMPLETED,
            uploadedAt: '2026-01-18T09:15:00.000Z',
          }
        : {}),
      // Two of the four outstanding are past their deadline.
      ...(index >= 8 ? { deadlineState: DEADLINE_STATE.OVERDUE, daysRemaining: -9 } : {}),
    }),
  )
}

function form(overrides: Partial<EmployeeFormData> = {}): EmployeeFormData {
  return { employee: employee(), documents: fullChecklist(), photo: null, ...overrides }
}

/** Reads the words back out of a generated PDF, one string per page. */
async function pagesOf(pdf: Buffer): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const parsed = await getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise

  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return pages
  } finally {
    await parsed.destroy()
  }
}

describe('checklistStatus', () => {
  it('counts a document with a file as received, however far through review it is', () => {
    for (const status of [
      DOCUMENT_STATUS.UPLOADED,
      DOCUMENT_STATUS.UNDER_REVIEW,
      DOCUMENT_STATUS.VERIFIED,
    ]) {
      expect(checklistStatus(document(1, { status }))).toBe('Uploaded')
    }
  })

  it('reads a rejected document as still outstanding', () => {
    // The file that was sent has been refused, so the paper is still to be
    // collected - printing it as received would take it off somebody's list.
    expect(checklistStatus(document(1, { status: DOCUMENT_STATUS.REJECTED }))).toBe('Pending')
  })

  it('reads an outstanding document past its deadline as overdue', () => {
    expect(
      checklistStatus(document(1, { deadlineState: DEADLINE_STATE.OVERDUE })),
    ).toBe('Overdue')
  })
})

describe('file names', () => {
  it('names one employee_s form by code and name', () => {
    expect(formFileName({ employeeCode: 'EMP-1010', employeeName: 'BHAGWAN SINGH' })).toBe(
      'EMP-1010_BHAGWAN_SINGH.pdf',
    )
  })

  it('reduces anything a header or a file system would argue about', () => {
    expect(
      formFileName({ employeeCode: 'EMP/22', employeeName: 'Ram "Raju" Yadav, Jr.' }),
    ).toBe('EMP_22_RAM_RAJU_YADAV_JR.pdf')
  })

  it('names a print of several by the day it was taken', () => {
    expect(bulkFileName(GENERATED_AT)).toBe('EMPLOYEE_FORMS_2026-09-03.pdf')
  })
})

describe('renderEmployeeForms', () => {
  it('prints every detail of a complete employee on one page', async () => {
    const [page, ...rest] = await pagesOf(await renderEmployeeForms([form()], META))

    expect(rest).toHaveLength(0)
    expect(page).toContain('ASPS International LLP')
    expect(page).toContain('EMP-1010')
    expect(page).toContain('BHAGWAN SINGH')
    expect(page).toContain('12/01/2026')
    expect(page).toContain('JACKET FRONT')
    expect(page).toContain('ASSTT.OPERATER')
    expect(page).toContain('07/04/1991')
    expect(page).toContain('9812345670')
    expect(page).toContain('Faridabad')
    expect(page).toContain('Active')
    expect(page).toContain('Signature on file: Yes')

    // The count line, in the words the office reads it in.
    expect(page).toContain('6 of 10 documents received')
    expect(page).toContain('4 outstanding, of which 2 overdue')

    // And the footer, on the only page there is.
    expect(page).toContain('Generated 03/09/2026 14:20 by Sameer Hashmi')
    expect(page).toContain('Page 1 of 1')
  })

  it('never prints the identity numbers or anything like a salary', async () => {
    // The sheet goes round the office. These are on the record and must not be
    // on the paper - the whole reason this renderer is given the profile and
    // chooses from it rather than printing what it is handed.
    const [page] = await pagesOf(await renderEmployeeForms([form()], META))

    expect(page).not.toContain('123456789012')
    expect(page).not.toContain('ABCDE1234F') // asps-dms:allow-secret - the invented PAN above
    expect(page).not.toContain('100200300400')
    expect(page).not.toContain('3100200300400')
    expect(page?.toLowerCase()).not.toContain('salary')
  })

  it('shows a dash for an empty field and still fits on one page', async () => {
    const sparse = form({
      employee: employee({
        department: null,
        designation: null,
        dateOfBirth: null,
        phoneNumber: null,
        address: null,
        hasSignature: false,
        signatureUpdatedAt: null,
      }),
    })

    const pages = await pagesOf(await renderEmployeeForms([sparse], META))

    expect(pages).toHaveLength(1)
    const [page = ''] = pages
    // Every label is still there - a row that disappears when it is empty is a
    // field nobody knows to fill in.
    for (const label of [
      'DEPARTMENT',
      'DESIGNATION',
      'DATE OF BIRTH',
      'MOBILE NUMBER',
      'ADDRESS',
      "FATHER'S NAME",
    ]) {
      expect(page).toContain(label)
    }
    expect(page).toContain('—')
    expect(page).toContain('Signature on file: No')
  })

  it("fits a ten-document checklist on the employee's one page", async () => {
    const pages = await pagesOf(await renderEmployeeForms([form()], META))

    expect(pages).toHaveLength(1)
    for (const documentName of form().documents.map((row) => row.documentName)) {
      expect(pages[0]).toContain(documentName)
    }
    expect(pages[0]).toContain('Mandatory')
    expect(pages[0]).toContain('Optional')
    expect(pages[0]).toContain('Overdue')
    expect(pages[0]).toContain('Pending')
  })

  it('prints the form of somebody who has left, with their exit details', async () => {
    const left = form({
      employee: employee({
        employmentStatus: EMPLOYMENT_STATUSES.LEFT,
        resignationDate: '2026-06-01',
        lastWorkingDate: '2026-06-30',
        exitReason: EXIT_REASONS.RESIGNED,
        exitNotes: 'Returned to his village.',
      }),
    })

    const pages = await pagesOf(await renderEmployeeForms([left], META))

    expect(pages).toHaveLength(1)
    const [page = ''] = pages
    expect(page).toContain('Left')
    expect(page).toContain('01/06/2026')
    expect(page).toContain('30/06/2026')
    expect(page).toContain('Resigned')
    expect(page).toContain('Returned to his village.')
    // Still a checklist: leaving does not remove what was never collected.
    expect(page).toContain('6 of 10 documents received')
  })

  it('prints twenty employees as twenty separate pages, numbered', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      form({
        employee: employee({
          employeeId: index + 1,
          employeeCode: `EMP-${1000 + index}`,
          employeeName: `EMPLOYEE ${index + 1}`,
        }),
      }),
    )

    const pdf = await renderEmployeeForms(many, META)
    const pages = await pagesOf(pdf)

    expect(pages).toHaveLength(20)
    pages.forEach((page, index) => {
      // Each employee begins on their own sheet, so a stack of them can be
      // separated and filed.
      expect(page).toContain(`EMP-${1000 + index}`)
      expect(page).toContain(`Page ${index + 1} of 20`)
    })

    // One PDF, not twenty concatenated files.
    const parsed = await PDFDocument.load(pdf)
    expect(parsed.getPageCount()).toBe(20)
  })

  it('draws the letterhead photograph when there is one, and copes when there is not', async () => {
    /* 1x1 transparent PNG - the smallest thing pdf-lib will embed. */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )

    const withPhoto = await renderEmployeeForms(
      [form({ photo: { data: png, mimeType: 'image/png' } })],
      META,
    )
    expect(await pagesOf(withPhoto)).toHaveLength(1)

    // A photograph that will not decode must not take the print down with it:
    // a form with no picture is still the form somebody asked for.
    const broken = await renderEmployeeForms(
      [form({ photo: { data: Buffer.from('not an image'), mimeType: 'image/png' } })],
      META,
    )
    const pages = await pagesOf(broken)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('BHAGWAN SINGH')
  })

  it('replaces characters the standard fonts cannot draw instead of failing', async () => {
    // A name typed in Devanagari would otherwise throw inside pdf-lib and take
    // the other nineteen forms in the print with it.
    const pages = await pagesOf(
      await renderEmployeeForms(
        [form({ employee: employee({ address: 'फरीदाबाद, हरियाणा' }) })],
        META,
      ),
    )

    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('?')
  })
})

/* -------------------------------------------------------------------------- */
/* The employee file                                                           */
/* -------------------------------------------------------------------------- */

/** A real PDF with the given words, one page each. */
async function pdfOf(words: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  for (const text of words) {
    const page = pdf.addPage([595.28, 841.89])
    page.drawText(text, { x: 60, y: 700, font, size: 18 })
  }
  return Buffer.from(await pdf.save())
}

/** A real photograph, the shape a phone takes one. */
async function jpegOf(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 1600, channels: 3, background: { r: 210, g: 210, b: 210 } },
  })
    .jpeg()
    .toBuffer()
}

function fileEntry(
  documentName: string,
  file: { read: () => Promise<Buffer>; mimeType: string; isSigned?: boolean },
): DocumentEntry {
  return {
    documentName,
    isMandatory: true,
    uploadedAt: '2026-01-18T09:15:00.000Z',
    uploadedByName: 'Pragati Dixit',
    file: { read: file.read, mimeType: file.mimeType, isSigned: file.isSigned ?? false },
  }
}

const employeeFile = (documents: DocumentEntry[], profile = employee()): EmployeeFileData => ({
  employee: profile,
  photo: null,
  documents,
})

describe('renderEmployeeFile', () => {
  it('opens with the employee, not with a checklist', async () => {
    const pages = await pagesOf(await renderEmployeeFile(employeeFile([]), META))
    const [first = ''] = pages

    expect(first).toContain('BHAGWAN SINGH')
    expect(first).toContain('EMP-1010')
    expect(first).toContain('JACKET FRONT')
    expect(first).toContain('ASSTT.OPERATER')
    expect(first).toContain('12/01/2026')
    expect(first).toContain('07/04/1991')
    expect(first).toContain('Male')
    expect(first).toContain('9812345670')
    expect(first).toContain('Faridabad')
    expect(first).toContain('Active')
  })

  it('has no checklist on it anywhere', async () => {
    // The whole point of the change. This file goes to somebody outside the
    // office; what the office is still chasing is nobody else's business, and
    // a deadline printed beside a document reads as a judgement on the person.
    const pdf = await renderEmployeeFile(
      employeeFile([
        fileEntry('Appointment Letter', {
          read: () => pdfOf(['LETTER']),
          mimeType: 'application/pdf',
        }),
      ]),
      META,
    )

    const text = (await pagesOf(pdf)).join(' ')
    for (const word of [
      'Document checklist',
      'documents received',
      'Due date',
      'Pending',
      'Overdue',
      'outstanding',
      'Not yet received',
      'Signature on file',
    ]) {
      expect(text, word).not.toContain(word)
    }
  })

  it('keeps the Aadhaar number and the PAN off it', async () => {
    // The rule the checklist form has always followed, and this page is the
    // one most likely to leave the building.
    const text = (await pagesOf(await renderEmployeeFile(employeeFile([]), META))).join(' ')

    expect(text).not.toContain('123456789012')
    expect(text).not.toContain('ABCDE1234F') // asps-dms:allow-secret
  })

  it('is one page when nothing has been uploaded', async () => {
    // Asked for somebody's file on their first day, the true answer is their
    // details and no documents - not an error.
    expect(await pagesOf(await renderEmployeeFile(employeeFile([]), META))).toHaveLength(1)
  })

  it('binds the documents on behind the details, in the order given', async () => {
    const pdf = await renderEmployeeFile(
      employeeFile([
        fileEntry('Appointment Letter', {
          read: () => pdfOf(['LETTER PAGE']),
          mimeType: 'application/pdf',
          isSigned: true,
        }),
        fileEntry('Service Card', {
          read: () => pdfOf(['CARD PAGE']),
          mimeType: 'application/pdf',
        }),
      ]),
      META,
    )

    const pages = await pagesOf(pdf)

    expect(pages).toHaveLength(5) // details + (separator + page) x 2
    expect(pages[1]).toContain('Appointment Letter')
    expect(pages[1]).toContain('Signed copy')
    expect(pages[2]).toContain('LETTER PAGE')
    expect(pages[3]).toContain('Service Card')
    expect(pages[3]).toContain('As it was uploaded')
    expect(pages[4]).toContain('CARD PAGE')
  })

  it('turns a photographed document into a page', async () => {
    const pdf = await renderEmployeeFile(
      employeeFile([
        fileEntry('Aadhaar Card', { read: () => jpegOf(), mimeType: 'image/jpeg' }),
      ]),
      META,
    )

    const parsed = await PDFDocument.load(pdf)
    expect(parsed.getPageCount()).toBe(3)

    const page = parsed.getPage(2)
    expect(Math.round(page.getWidth())).toBe(595)
    expect(Math.round(page.getHeight())).toBe(842)
  })

  it('reads each document once, and only when its turn comes', async () => {
    // Ten scans is a hundred megabytes. Reading them all up front to decide
    // what to draw is the difference between a server that builds this and one
    // that falls over on the third employee of the morning.
    const reads: string[] = []
    const watched = (name: string, mimeType: string, data: () => Promise<Buffer>): DocumentEntry =>
      fileEntry(name, {
        mimeType,
        read: async () => {
          reads.push(name)
          return data()
        },
      })

    await renderEmployeeFile(
      employeeFile([
        watched('Appointment Letter', 'application/pdf', () => pdfOf(['A'])),
        watched('Old Archive', 'application/zip', async () => Buffer.from('zip')),
        watched('Service Card', 'application/pdf', () => pdfOf(['B'])),
      ]),
      META,
    )

    // The zip is never read: nothing can be done with it, and reading it would
    // pull a file into memory only to throw it away.
    expect(reads).toEqual(['Appointment Letter', 'Service Card'])
  })

  it('footers its own pages and leaves the documents alone', async () => {
    const pages = await pagesOf(
      await renderEmployeeFile(
        employeeFile([
          fileEntry('Appointment Letter', {
            read: () => pdfOf(['SCANNED CARD']),
            mimeType: 'application/pdf',
          }),
        ]),
        META,
      ),
    )

    expect(pages[0]).toContain('Generated 03/09/2026 14:20 by Sameer Hashmi')
    expect(pages[1]).toContain('Page 2 of 3')
    expect(pages[2]).toContain('SCANNED CARD')
    expect(pages[2]).not.toContain('Sameer Hashmi')
  })
})

describe('the documents inside the employee file', () => {
  /** A real image, in whichever format is asked for. */
  async function imageOf(format: 'png' | 'tiff' | 'webp'): Promise<Buffer> {
    const canvas = sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 220, g: 220, b: 220 } },
    })
    return format === 'png'
      ? canvas.png().toBuffer()
      : format === 'tiff'
        ? canvas.tiff().toBuffer()
        : canvas.webp().toBuffer()
  }

  it('keeps every page of a document that has several', async () => {
    const pages = await pagesOf(
      await renderEmployeeFile(
        employeeFile([
          fileEntry('Appointment Letter', {
            read: () => pdfOf(['ONE', 'TWO', 'THREE']),
            mimeType: 'application/pdf',
          }),
        ]),
        META,
      ),
    )

    expect(pages).toHaveLength(5) // details + separator + three
    expect(pages[2]).toContain('ONE')
    expect(pages[3]).toContain('TWO')
    expect(pages[4]).toContain('THREE')
  })

  it('converts the image formats a PDF cannot hold', async () => {
    // WEBP and TIFF are both accepted uploads and neither can be embedded.
    for (const format of ['tiff', 'webp', 'png'] as const) {
      const data = await imageOf(format)
      const pdf = await renderEmployeeFile(
        employeeFile([
          fileEntry('Aadhaar Card', { read: async () => data, mimeType: `image/${format}` }),
        ]),
        META,
      )

      expect((await PDFDocument.load(pdf)).getPageCount(), format).toBe(3)
    }
  })

  it('accounts for a document it cannot read rather than dropping it', async () => {
    // A file the store has lost, or one that is not really a PDF. Silently
    // handing over nine of ten is how somebody comes to believe a document was
    // never collected.
    const pages = await pagesOf(
      await renderEmployeeFile(
        employeeFile([
          fileEntry('Bio Data Form', {
            read: async () => Buffer.from('not a pdf at all'),
            mimeType: 'application/pdf',
          }),
          fileEntry('Service Card', {
            read: () => pdfOf(['GOOD ONE']),
            mimeType: 'application/pdf',
          }),
        ]),
        META,
      ),
    )

    expect(pages[1]).toContain('Bio Data Form')
    expect(pages[2]).toContain('could not be read')
    // And the one after it is unaffected.
    expect(pages[3]).toContain('Service Card')
    expect(pages[4]).toContain('GOOD ONE')
  })

  it('says on the separator when the type cannot be included at all', async () => {
    const pages = await pagesOf(
      await renderEmployeeFile(
        employeeFile([
          fileEntry('Old Archive', {
            read: async () => Buffer.from('zip'),
            mimeType: 'application/zip',
          }),
        ]),
        META,
      ),
    )

    expect(pages).toHaveLength(2)
    expect(pages[1]).toContain('application/zip')
  })
})
