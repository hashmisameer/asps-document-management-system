import { describe, expect, it } from 'vitest'
import { documentViewer } from '../../src/features/signatures/placementModel.js'

/**
 * How the signing screen shows a document. A picture - the common case for an
 * Aadhaar or PAN card - is shown as a picture; pdf.js cannot open one, which is
 * why the screen used to say 'Only PDFs can be signed here' to a signable card.
 */
describe('documentViewer', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'])(
    'shows an unsigned %s as a picture',
    (mimeType) => {
      expect(documentViewer({ mimeType, hasProcessedFile: false })).toBe('image')
    },
  )

  it('shows a PDF with pdf.js', () => {
    expect(documentViewer({ mimeType: 'application/pdf', hasProcessedFile: false })).toBe('pdf')
  })

  it('shows a signed picture as its signed copy, which is always a PDF', () => {
    expect(documentViewer({ mimeType: 'image/jpeg', hasProcessedFile: true })).toBe('pdf')
  })

  it('falls back to pdf.js when the type is not recorded', () => {
    expect(documentViewer({ mimeType: null, hasProcessedFile: false })).toBe('pdf')
  })
})
