import { describe, expect, it } from 'vitest'
import { logSafeText, maskIdentityNumbers } from '../../src/utils/redact.js'

/**
 * Keeping identity numbers out of the log files.
 *
 * The reason this is tested at all: these logs are never rotated or deleted, so
 * anything written here once per upload accumulates. 550 employees' PAN and
 * Aadhaar numbers in a plain text file beside the application would undo the
 * point of hosting the whole system inside the building.
 */

describe('masking an identity number', () => {
  it('takes the PAN number out of what a PAN card reads as', () => {
    // The shape is fixed: five letters, four digits, a letter.
    const text = 'INCOME TAX DEPARTMENT ABCDE1234F BHAGWAN SINGH' // asps-dms:allow-secret

    expect(maskIdentityNumbers(text)).toBe('INCOME TAX DEPARTMENT PAN-XXXXX BHAGWAN SINGH')
  })

  it('takes it out however OCR spaced it and whatever case it came back in', () => {
    expect(maskIdentityNumbers('abcde1234f')).toBe('PAN-XXXXX') // asps-dms:allow-secret
    expect(maskIdentityNumbers('ABCDE 1234 F')).toBe('PAN-XXXXX') // asps-dms:allow-secret
  })

  it('takes the Aadhaar number out, grouped or not', () => {
    expect(maskIdentityNumbers('1234 5678 9012')).toBe('AADHAAR-XXXX')
    expect(maskIdentityNumbers('123456789012')).toBe('AADHAAR-XXXX')
  })

  it('leaves everything else alone, because the rest is what is worth reading', () => {
    const text = 'GOVERNMENT OF INDIA - BHAGWAN SINGH - DOB 07/04/1991'

    expect(maskIdentityNumbers(text)).toBe(text)
  })

  it('masks every one it finds, not only the first', () => {
    const masked = maskIdentityNumbers('ABCDE1234F and 1234 5678 9012 and ZZZZZ9999Z') // asps-dms:allow-secret

    expect(masked).toBe('PAN-XXXXX and AADHAAR-XXXX and PAN-XXXXX')
  })
})

describe('what may be written to a log', () => {
  it('masks BEFORE it truncates, which is the whole point of the order', () => {
    // A PAN card prints its number near the top, so the first 200 characters
    // are exactly where it is. Cutting first would keep it.
    const text = `PAN ABCDE1234F ${'x'.repeat(400)}` // asps-dms:allow-secret

    const safe = logSafeText(text)

    expect(safe).not.toContain('ABCDE1234F') // asps-dms:allow-secret
    expect(safe).toContain('PAN-XXXXX')
  })

  it('keeps 200 characters and says it stopped there', () => {
    const safe = logSafeText('y'.repeat(500))

    expect(safe).toHaveLength(203)
    expect(safe.endsWith('...')).toBe(true)
  })

  it('leaves a short reading whole, marker and all', () => {
    expect(logSafeText('BHAGWAN SINGH')).toBe('BHAGWAN SINGH')
  })

  it('survives a document that read as nothing', () => {
    expect(logSafeText('')).toBe('')
  })
})
