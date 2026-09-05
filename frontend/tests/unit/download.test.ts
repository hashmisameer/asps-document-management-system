import { describe, expect, it } from 'vitest'
import { fileNameFromDisposition } from '../../src/lib/download.js'

/**
 * Reading the name the server chose for a downloaded file.
 *
 * The server names these - employee code and name for one form, the day it was
 * taken for a print of many - and that name is the whole point: a downloads
 * folder full of 'print.pdf' is a folder nobody can find anything in. This is
 * the one piece of that path with anything to get wrong.
 *
 * Only the parsing is tested. saveBlob needs a DOM, and these tests run in Node.
 */

const FALLBACK = 'employee-form.pdf'

describe('fileNameFromDisposition', () => {
  it('reads the quoted name the API sends', () => {
    expect(
      fileNameFromDisposition('attachment; filename="EMP-1010_BHAGWAN_SINGH.pdf"', FALLBACK),
    ).toBe('EMP-1010_BHAGWAN_SINGH.pdf')
  })

  it('reads an unquoted name', () => {
    expect(fileNameFromDisposition('attachment; filename=EMP001.pdf', FALLBACK)).toBe('EMP001.pdf')
  })

  it('prefers the extended form when a server sends both', () => {
    expect(
      fileNameFromDisposition(
        "attachment; filename=\"forms.pdf\"; filename*=UTF-8''EMPLOYEE_FORMS_2026-09-03.pdf",
        FALLBACK,
      ),
    ).toBe('EMPLOYEE_FORMS_2026-09-03.pdf')
  })

  it('falls back when the header is missing, which is what a proxy that strips it leaves', () => {
    expect(fileNameFromDisposition(null, FALLBACK)).toBe(FALLBACK)
    expect(fileNameFromDisposition(undefined, FALLBACK)).toBe(FALLBACK)
    expect(fileNameFromDisposition('attachment', FALLBACK)).toBe(FALLBACK)
  })

  it('will not let a name out of the downloads folder', () => {
    // The header is written by this API, but a downloaded file name should not
    // be able to climb a directory just because that stayed true.
    expect(
      fileNameFromDisposition('attachment; filename="../../secrets.pdf"', FALLBACK),
    ).toBe('_.._secrets.pdf')
  })

  it('survives a malformed escape rather than failing the download', () => {
    expect(
      fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4", FALLBACK),
    ).toBe(FALLBACK)
  })
})
