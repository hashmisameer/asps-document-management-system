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

export async function uploadSignature(
  employeeId: number,
  file: File,
): Promise<EmployeeSignatureSummary> {
  const form = new FormData()
  form.append('file', file)
  const response = await api.post<{ signature: EmployeeSignatureSummary }>(
    `/employees/${employeeId}/signature`,
    form,
  )
  return response.data.signature
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
  placements: (documentId: number) => ['placements', documentId] as const,
}
