import type { EmployeeDocument, UploadDocumentInput } from '@asps-dms/shared'
import { api } from '../../lib/api.js'

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
