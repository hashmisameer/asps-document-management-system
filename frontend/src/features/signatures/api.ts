import type { EmployeeDocument, SavePlacementsInput, SignaturePlacement } from '@asps-dms/shared'
import { api } from '../../lib/api.js'

/**
 * Signatures and their placements.
 *
 * Two resources, because they are two things: the signature belongs to the
 * employee and is uploaded once, while the placements belong to one document
 * and say where that signature goes on it.
 */

export interface EmployeeSignatureSummary {
  employeeId: number
  hasSignature: boolean
  mimeType: string | null
  widthPx: number | null
  heightPx: number | null
  uploadedAt: string | null
}

export async function fetchSignature(employeeId: number): Promise<EmployeeSignatureSummary> {
  const response = await api.get<{ signature: EmployeeSignatureSummary }>(
    `/employees/${employeeId}/signature`,
  )
  return response.data.signature
}

/**
 * The signature as drawn on the pad.
 *
 * A Blob rather than a File because that is what a canvas produces, and the
 * name is invented here: the server stores a UUID and never shows an uploaded
 * name to anyone, so a real one would only be personal data travelling for no
 * reason. `capture` records that this was drawn rather than scanned.
 */
function signatureForm(png: Blob, capture: 'Drawn' | 'Uploaded' = 'Drawn'): FormData {
  const form = new FormData()
  form.append('file', new File([png], 'signature.png', { type: 'image/png' }))
  form.append('capture', capture)
  return form
}

export async function uploadSignature(
  employeeId: number,
  png: Blob,
): Promise<EmployeeSignatureSummary> {
  const response = await api.post<{ signature: EmployeeSignatureSummary }>(
    `/employees/${employeeId}/signature`,
    signatureForm(png),
  )
  return response.data.signature
}

/**
 * The signed-in user's own authorising signature.
 *
 * A different resource from an employee's, and under /me rather than under a
 * user id: this mark is what says who signed a document off, so there is
 * deliberately no request by which one person can set another's.
 */
export interface UserSignatureSummary {
  userId: number
  hasSignature: boolean
  mimeType: string | null
  widthPx: number | null
  heightPx: number | null
  captureMethod: 'Drawn' | 'Uploaded' | null
  updatedAt: string | null
}

export async function fetchMySignature(): Promise<UserSignatureSummary> {
  const response = await api.get<{ signature: UserSignatureSummary }>('/me/signature')
  return response.data.signature
}

export async function saveMySignature(png: Blob): Promise<UserSignatureSummary> {
  const response = await api.post<{ signature: UserSignatureSummary }>(
    '/me/signature',
    signatureForm(png),
  )
  return response.data.signature
}

export function mySignatureImageUrl(version: string | null): string {
  const base = '/api/me/signature/image'
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

/**
 * The image itself.
 *
 * `version` is the upload timestamp, so replacing a signature shows the new one
 * immediately instead of whatever the browser already has under that URL.
 */
export function signatureImageUrl(employeeId: number, version: string | null): string {
  const base = `/api/employees/${employeeId}/signature/image`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

export async function fetchPlacements(documentId: number): Promise<SignaturePlacement[]> {
  const response = await api.get<{ placements: SignaturePlacement[] }>(
    `/documents/${documentId}/placements`,
  )
  return response.data.placements
}

/**
 * Replaces a document's placements and regenerates the signed copy.
 *
 * PUT of the complete set: the signed PDF is rebuilt from the original against
 * exactly what is sent, so there is no such thing as a partial update. An empty
 * array removes the signature.
 */
export async function savePlacements(
  documentId: number,
  input: SavePlacementsInput,
): Promise<EmployeeDocument> {
  const response = await api.put<{ document: EmployeeDocument }>(
    `/documents/${documentId}/placements`,
    input,
  )
  return response.data.document
}

export async function skipSignature(
  documentId: number,
  reason?: string,
): Promise<EmployeeDocument> {
  const response = await api.post<{ document: EmployeeDocument }>(
    `/documents/${documentId}/skip-signature`,
    { reason },
  )
  return response.data.document
}

export const signatureKeys = {
  employee: (employeeId: number) => ['signature', employeeId] as const,
  mine: ['signature', 'me'] as const,
  placements: (documentId: number) => ['placements', documentId] as const,
}
