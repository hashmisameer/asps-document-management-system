import { describe, expect, it } from 'vitest'
import { SIGNATURE_STATUS, type SignatureStatus } from '@asps-dms/shared'
import { signButton } from '../../src/features/documents/signButton.js'

/**
 * The Sign button in a checklist row: clickable in every signature state,
 * disabled when there is no file, and not shown to somebody who cannot sign.
 */

const ALL_STATES: SignatureStatus[] = Object.values(SIGNATURE_STATUS)

describe('signButton', () => {
  it.each(ALL_STATES)('is clickable on a document that is %s', (signatureStatus) => {
    expect(signButton({ signatureStatus, hasFile: true, canPlace: true })?.disabled).toBe(false)
  })

  it('says what each state is, and that opening it is how to change it', () => {
    const label = (signatureStatus: SignatureStatus) =>
      signButton({ signatureStatus, hasFile: true, canPlace: true })?.label
    expect(label(SIGNATURE_STATUS.ADDED)).toBe('Signature added - open to change')
    expect(label(SIGNATURE_STATUS.NOT_REQUIRED)).toBe('No signature is needed - open to sign anyway')
    expect(label(SIGNATURE_STATUS.SKIPPED)).toBe('Signature skipped - open to sign')
    expect(label(SIGNATURE_STATUS.REVIEW_REQUIRED)).toBe('Sign')
    expect(label(SIGNATURE_STATUS.PENDING_DETECTION)).toBe('Sign')
  })

  it('shows the tick on a signed document, clickable or not', () => {
    expect(
      signButton({ signatureStatus: SIGNATURE_STATUS.ADDED, hasFile: true, canPlace: true })?.done,
    ).toBe(true)
    expect(
      signButton({ signatureStatus: SIGNATURE_STATUS.ADDED, hasFile: false, canPlace: true })?.done,
    ).toBe(true)
    expect(
      signButton({ signatureStatus: SIGNATURE_STATUS.SKIPPED, hasFile: true, canPlace: true })?.done,
    ).toBe(false)
  })

  it.each(ALL_STATES)('is disabled with no file to sign, whatever the state (%s)', (signatureStatus) => {
    expect(signButton({ signatureStatus, hasFile: false, canPlace: true })).toMatchObject({
      disabled: true,
      label: 'There is no file to sign yet',
    })
  })

  it.each(ALL_STATES)('is not shown to somebody who cannot sign (%s)', (signatureStatus) => {
    // A fact about the person: a Viewer can never sign, so nothing is drawn.
    expect(signButton({ signatureStatus, hasFile: true, canPlace: false })).toBeNull()
    expect(signButton({ signatureStatus, hasFile: false, canPlace: false })).toBeNull()
  })
})
