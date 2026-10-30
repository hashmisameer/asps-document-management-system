import { SIGNATURE_STATUS, type SignatureStatus } from '@asps-dms/shared'

/**
 * What the Sign button in a checklist row says, and whether it does anything.
 *
 * ALWAYS CLICKABLE, in every signature state - Added, Not required and
 * Skipped included - and with no confirmation: the button only opens the
 * editor, and nothing is stamped until the editor's own save. A document
 * already signed is re-signed by opening it and saving, and one marked as
 * needing no signature can still be signed by somebody who decides it does.
 *
 * NOT SHOWN AT ALL to somebody without SIGNATURE_PLACE. That is a fact about
 * the person, not the document: a Viewer can never sign anything, and a
 * greyed button on every row of every document would tell them nothing they
 * could act on. DISABLED, with the reason in the tooltip, when there is no
 * file to sign - a fact about this document, and worth reading. Disabled
 * means aria-disabled, so the tooltip and the tab stop remain - see
 * IconButton.
 *
 * What stops a second signature on a page that has one is the editor and
 * the server, not this button: see placementLimits.
 */

export interface SignButton {
  /** The tick icon rather than the pen: a signature is already on it. */
  done: boolean
  disabled: boolean
  label: string
}

/** The button, or null when it is not shown: the person cannot sign anything. */
export function signButton(input: {
  signatureStatus: SignatureStatus
  hasFile: boolean
  canPlace: boolean
}): SignButton | null {
  if (!input.canPlace) return null

  const done = input.signatureStatus === SIGNATURE_STATUS.ADDED
  if (!input.hasFile) {
    return { done, disabled: true, label: 'There is no file to sign yet' }
  }

  switch (input.signatureStatus) {
    case SIGNATURE_STATUS.ADDED:
      return { done, disabled: false, label: 'Signature added - open to change' }
    case SIGNATURE_STATUS.NOT_REQUIRED:
      return { done, disabled: false, label: 'No signature is needed - open to sign anyway' }
    case SIGNATURE_STATUS.SKIPPED:
      return { done, disabled: false, label: 'Signature skipped - open to sign' }
    default:
      return { done, disabled: false, label: 'Sign' }
  }
}
