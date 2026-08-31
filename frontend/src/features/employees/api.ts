import type {
  CreateEmployeeInput,
  DocumentType,
  EmployeeDocument,
  EmployeeListItem,
  EmployeeListQuery,
  Employee,
  EmployeeProfile,
  Paginated,
  UpdateEmployeeInput,
} from '@asps-dms/shared'
import { api } from '../../lib/api.js'

/**
 * Employee endpoints.
 *
 * The query parameters are the same shape the server validates with
 * (employeeListQuerySchema), so a filter the UI can express is by construction
 * one the API accepts.
 */

export type EmployeeListParams = Partial<EmployeeListQuery>

export interface EmployeeFacets {
  departments: string[]
  designations: string[]
}

export async function listEmployees(
  params: EmployeeListParams,
): Promise<Paginated<EmployeeListItem>> {
  const response = await api.get<Paginated<EmployeeListItem>>('/employees', { params })
  return response.data
}

export async function fetchFacets(): Promise<EmployeeFacets> {
  const response = await api.get<EmployeeFacets>('/employees/facets')
  return response.data
}

export async function fetchEmployee(employeeId: number): Promise<EmployeeProfile> {
  const response = await api.get<{ employee: EmployeeProfile }>(`/employees/${employeeId}`)
  return response.data.employee
}

export async function fetchEmployeeDocuments(employeeId: number): Promise<EmployeeDocument[]> {
  const response = await api.get<{ documents: EmployeeDocument[] }>(
    `/employees/${employeeId}/documents`,
  )
  return response.data.documents
}

export async function createEmployee(input: CreateEmployeeInput): Promise<EmployeeProfile> {
  const response = await api.post<{ employee: EmployeeProfile }>('/employees', input)
  return response.data.employee
}

export async function updateEmployee(
  employeeId: number,
  input: UpdateEmployeeInput,
): Promise<EmployeeProfile> {
  const response = await api.patch<{ employee: EmployeeProfile }>(
    `/employees/${employeeId}`,
    input,
  )
  return response.data.employee
}

/**
 * Archive and restore are separate endpoints rather than a flag on the update,
 * because they are separate permissions: HR can edit an employee's details
 * without being able to take them off the active list.
 */
export async function setEmployeeArchived(
  employeeId: number,
  archived: boolean,
): Promise<EmployeeProfile> {
  const response = await api.post<{ employee: EmployeeProfile }>(
    `/employees/${employeeId}/${archived ? 'archive' : 'restore'}`,
  )
  return response.data.employee
}

export async function listDocumentTypes(): Promise<DocumentType[]> {
  const response = await api.get<{ documentTypes: DocumentType[] }>('/document-types')
  return response.data.documentTypes
}

/**
 * Query keys.
 *
 * Every key starts with 'employees', so invalidating that prefix after a
 * mutation refreshes the list, the detail and the counts together - a rename
 * that showed on one screen and not the other would be worse than no cache.
 */
export const employeeKeys = {
  all: ['employees'] as const,
  lists: () => [...employeeKeys.all, 'list'] as const,
  list: (params: EmployeeListParams) => [...employeeKeys.lists(), params] as const,
  facets: () => [...employeeKeys.all, 'facets'] as const,
  detail: (employeeId: number) => [...employeeKeys.all, 'detail', employeeId] as const,
  documents: (employeeId: number) => [...employeeKeys.all, 'documents', employeeId] as const,
}

export const documentTypeKeys = {
  all: ['documentTypes'] as const,
}

/**
 * The photograph URL.
 *
 * An ordinary same-origin link, so the session cookie goes with it: there is no
 * token in the URL to end up in a history or a proxy log. The version string
 * busts the browser cache when a new photo replaces the old one - without it a
 * replaced photograph keeps showing the previous face.
 */
export function employeePhotoUrl(employeeId: number, version: string | null): string {
  const base = `/api/employees/${employeeId}/photo/image`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

export async function uploadEmployeePhoto(employeeId: number, file: File): Promise<Employee> {
  const form = new FormData()
  form.append('file', file)
  // Content-Type is left alone: the browser adds it with the multipart
  // boundary, and setting it by hand removes the boundary.
  const response = await api.post<{ employee: Employee }>(
    `/employees/${employeeId}/photo`,
    form,
  )
  return response.data.employee
}
