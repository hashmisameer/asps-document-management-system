import type { EmployeeDocument, UploadDocumentInput } from '@asps-dms/shared'
import { api, DOCUMENT_READ_TIMEOUT_MS } from '../../lib/api.js'

/**
 * Document endpoints.
 *
 * The file itself travels as multipart; the metadata beside it as ordinary form
 * fields, validated by the same schema on both sides.
 */

/** One document, with its deadline state and identity-check outcome. */
export async function fetchDocument(documentId: number): Promise<EmployeeDocument> {
  const response = await api.get<{ document: EmployeeDocument }>(`/documents/${documentId}`)
  return response.data.document
}

export async function uploadDocument(
  documentId: number,
  file: File,
  input: Partial<UploadDocumentInput> = {},
): Promise<EmployeeDocument> {
  const form = new FormData()
  form.append('file', file)
  form.append('isExistingRecord', String(input.isExistingRecord ?? false))
  if (input.landingStatus) form.append('landingStatus', input.landingStatus)
  if (input.notes) form.append('notes', input.notes)
  // Only present when someone is knowingly accepting a document the identity
  // check refused. The reason travels with the file rather than as a second
  // request, so there is never a moment where an unexplained override exists.
  if (input.identityOverrideReason) {
    form.append('identityOverrideReason', input.identityOverrideReason)
  }

  // The Content-Type header is deliberately not set: the browser has to add it
  // with the multipart boundary, and setting it by hand removes the boundary.
  const response = await api.post<{ document: EmployeeDocument }>(
    `/documents/${documentId}/file`,
    form,
    // The server reads the document before storing it; see the constant.
    { timeout: DOCUMENT_READ_TIMEOUT_MS },
  )
  return response.data.document
}

/**
 * A person has looked at the document and says it is the right one.
 *
 * No reason travels with it. Every identity card here is a photocopy, OCR
 * failing to read a name off one is the ordinary case, and the server records a
 * fixed line saying a person confirmed it - see MANUAL_CONFIRMATION_REASON.
 */
export async function confirmDocumentIdentity(documentId: number): Promise<EmployeeDocument> {
  const response = await api.post<{ document: EmployeeDocument }>(
    `/documents/${documentId}/identity-override`,
    {},
  )
  return response.data.document
}

export async function verifyDocument(documentId: number): Promise<EmployeeDocument> {
  const response = await api.post<{ document: EmployeeDocument }>(`/documents/${documentId}/verify`)
  return response.data.document
}

export async function rejectDocument(
  documentId: number,
  reason: string,
): Promise<EmployeeDocument> {
  const response = await api.post<{ document: EmployeeDocument }>(
    `/documents/${documentId}/reject`,
    { reason },
  )
  return response.data.document
}

export async function updateDocumentDeadline(
  documentId: number,
  dueDate: string | null,
  reason?: string,
): Promise<EmployeeDocument> {
  const response = await api.patch<{ document: EmployeeDocument }>(
    `/documents/${documentId}/deadline`,
    { dueDate, reason },
  )
  return response.data.document
}

/**
 * The URLs the browser opens directly.
 *
 * Ordinary same-origin links: the session cookie goes with them because it
 * always does, so there is no token in a URL to end up in a browser history, a
 * proxy log or a shared link.
 */
export const documentFileUrl = {
  preview: (documentId: number) => `/api/documents/${documentId}/preview`,
  download: (documentId: number) => `/api/documents/${documentId}/download`,
}

/**
 * Takes the file off a document, returning the row to Pending.
 *
 * The checklist row survives: the document is still expected of this employee
 * and keeps its deadline. Only the file it was satisfied by is removed.
 */
export async function removeDocumentFile(documentId: number): Promise<EmployeeDocument> {
  const response = await api.delete<{ document: EmployeeDocument }>(
    `/documents/${documentId}/file`,
  )
  return response.data.document
}

/**
 * Checks an identity document against a name, with nothing stored.
 *
 * For the Add Employee screen, where the cards are collected before the record
 * exists. Reading can take half a minute when the name is NOT there - every
 * variant is tried before giving up - so this gets the long timeout too.
 */
export interface IdentityPreview {
  readable: boolean
  matched: boolean
  /** What the document seemed to say, when it disagreed. Best effort, or null. */
  nameFound: string | null
}

export async function previewIdentity(
  file: File,
  employeeName: string,
  documentName: string,
): Promise<IdentityPreview> {
  const form = new FormData()
  form.append('file', file)
  form.append('employeeName', employeeName)
  form.append('documentName', documentName)

  const response = await api.post<IdentityPreview>('/documents/identity-preview', form, {
    timeout: DOCUMENT_READ_TIMEOUT_MS,
  })
  return response.data
}

/**
 * Whether this document is expected of this employee at all.
 *
 * ESIC does not apply to everybody. The state is sent rather than a toggle, so
 * two clicks in a row land on one answer instead of flipping back and forth.
 */
export async function setDocumentNotRequired(
  documentId: number,
  notRequired: boolean,
): Promise<EmployeeDocument> {
  const response = await api.patch<{ document: EmployeeDocument }>(
    `/documents/${documentId}/not-required`,
    { notRequired },
  )
  return response.data.document
}
