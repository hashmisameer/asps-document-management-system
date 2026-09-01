/**
 * Document state.
 *
 * Two INDEPENDENT axes, deliberately:
 *
 *   DocumentStatus     - the lifecycle of the file itself
 *   SignatureStatus    - the lifecycle of signature placement
 *
 * A document may legitimately be Verified + SignatureSkipped, or Uploaded +
 * SignatureReviewRequired. Collapsing these into one column would make several
 * real combinations unrepresentable.
 *
 * 'Overdue' is deliberately NOT a stored status. It is derived from DueDate at
 * query time (see deadlines.ts), so it is always correct and never needs a
 * scheduled job to keep it accurate.
 */

export const DOCUMENT_STATUS = {
  PENDING: 'Pending',
  UPLOADED: 'Uploaded',
  UNDER_REVIEW: 'UnderReview',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
} as const

export type DocumentStatus = (typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS]

export const SIGNATURE_STATUS = {
  NOT_REQUIRED: 'NotRequired',
  PENDING_DETECTION: 'PendingDetection',
  REVIEW_REQUIRED: 'ReviewRequired',
  ADDED: 'Added',
  SKIPPED: 'Skipped',
} as const

export type SignatureStatus = (typeof SIGNATURE_STATUS)[keyof typeof SIGNATURE_STATUS]

/** Human-facing labels. Kept here so FE and BE never disagree on wording. */
export const DOCUMENT_STATUS_LABEL: Readonly<Record<DocumentStatus, string>> = {
  [DOCUMENT_STATUS.PENDING]: 'Pending',
  [DOCUMENT_STATUS.UPLOADED]: 'Uploaded',
  [DOCUMENT_STATUS.UNDER_REVIEW]: 'Under Review',
  [DOCUMENT_STATUS.VERIFIED]: 'Verified',
  [DOCUMENT_STATUS.REJECTED]: 'Rejected',
}

export const SIGNATURE_STATUS_LABEL: Readonly<Record<SignatureStatus, string>> = {
  [SIGNATURE_STATUS.NOT_REQUIRED]: 'Not Required',
  [SIGNATURE_STATUS.PENDING_DETECTION]: 'Detecting',
  [SIGNATURE_STATUS.REVIEW_REQUIRED]: 'Signature Review Required',
  [SIGNATURE_STATUS.ADDED]: 'Signature Added',
  [SIGNATURE_STATUS.SKIPPED]: 'Signature Skipped',
}

/**
 * Whose signature a placement carries.
 *
 * Two people sign a document, and they sign different boxes on it: the
 * EMPLOYEE, whose signature is enrolled once and reused (Section 24), and the
 * AUTHORISER - the HR user who is signing the document off. The role has to
 * travel with the placement because it is what tells the stamper which of the
 * two images to draw; a placement that only said WHERE would leave that to be
 * guessed, and a signature drawn in the wrong person's name is worse than one
 * drawn in the wrong place.
 */
export const SIGNER_ROLES = {
  EMPLOYEE: 'Employee',
  AUTHORISER: 'Authoriser',
} as const

export type SignerRole = (typeof SIGNER_ROLES)[keyof typeof SIGNER_ROLES]

export const SIGNER_ROLE_LABEL: Readonly<Record<SignerRole, string>> = {
  [SIGNER_ROLES.EMPLOYEE]: 'Employee signature',
  [SIGNER_ROLES.AUTHORISER]: 'HR signature',
}

/**
 * Allowed status transitions. Anything not listed here is rejected by the
 * service layer with 409 Conflict rather than silently written.
 */
export const ALLOWED_DOCUMENT_TRANSITIONS: Readonly<
  Record<DocumentStatus, readonly DocumentStatus[]>
> = {
  // A pending checklist row becomes Uploaded when HR uploads a file. HR may
  // also mark a pre-existing hard-copy document straight to Verified
  // (Section 19: existing employees).
  [DOCUMENT_STATUS.PENDING]: [DOCUMENT_STATUS.UPLOADED, DOCUMENT_STATUS.VERIFIED],
  [DOCUMENT_STATUS.UPLOADED]: [
    DOCUMENT_STATUS.UNDER_REVIEW,
    DOCUMENT_STATUS.VERIFIED,
    DOCUMENT_STATUS.REJECTED,
    DOCUMENT_STATUS.UPLOADED, // replace file, stays Uploaded
  ],
  [DOCUMENT_STATUS.UNDER_REVIEW]: [
    DOCUMENT_STATUS.VERIFIED,
    DOCUMENT_STATUS.REJECTED,
    DOCUMENT_STATUS.UPLOADED,
  ],
  // A verified document can be re-opened only by replacing the file.
  [DOCUMENT_STATUS.VERIFIED]: [DOCUMENT_STATUS.UPLOADED],
  // A rejected document is corrected by uploading a replacement.
  [DOCUMENT_STATUS.REJECTED]: [DOCUMENT_STATUS.UPLOADED],
}

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_DOCUMENT_TRANSITIONS[from]?.includes(to) ?? false
}

export const ALLOWED_SIGNATURE_TRANSITIONS: Readonly<
  Record<SignatureStatus, readonly SignatureStatus[]>
> = {
  [SIGNATURE_STATUS.NOT_REQUIRED]: [SIGNATURE_STATUS.PENDING_DETECTION],
  [SIGNATURE_STATUS.PENDING_DETECTION]: [
    SIGNATURE_STATUS.REVIEW_REQUIRED,
    SIGNATURE_STATUS.SKIPPED,
    SIGNATURE_STATUS.NOT_REQUIRED,
  ],
  [SIGNATURE_STATUS.REVIEW_REQUIRED]: [
    SIGNATURE_STATUS.ADDED,
    SIGNATURE_STATUS.SKIPPED,
    // A replacement file voids the review it was under.
    SIGNATURE_STATUS.PENDING_DETECTION,
  ],
  // HR may revisit a placed signature; the processed PDF is then regenerated
  // from the ORIGINAL, never from the previously processed file
  // (Sections 34 and 64).
  [SIGNATURE_STATUS.ADDED]: [
    SIGNATURE_STATUS.ADDED,
    SIGNATURE_STATUS.REVIEW_REQUIRED,
    SIGNATURE_STATUS.SKIPPED,
    // Replacing the file starts the signature work over: the placement that was
    // applied describes a page in a document that is no longer served, so it
    // cannot be carried forward.
    SIGNATURE_STATUS.PENDING_DETECTION,
  ],
  [SIGNATURE_STATUS.SKIPPED]: [
    SIGNATURE_STATUS.REVIEW_REQUIRED,
    SIGNATURE_STATUS.ADDED,
    SIGNATURE_STATUS.PENDING_DETECTION,
  ],
}

export function canTransitionSignature(from: SignatureStatus, to: SignatureStatus): boolean {
  return ALLOWED_SIGNATURE_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Upload constraints - enforced on BOTH client and server
 * (Sections 18 and 70). The client check is convenience only.
 */
export const ALLOWED_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

export type AllowedDocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number]

export const ALLOWED_DOCUMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'] as const

export const ALLOWED_SIGNATURE_MIME_TYPES = ['image/png', 'image/jpeg'] as const

export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB
export const MAX_SIGNATURE_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB

/** As Form-V records it. 'Not recorded' is absence, never a fourth value. */
export const GENDERS = ['Male', 'Female', 'Other'] as const

export type Gender = (typeof GENDERS)[number]
