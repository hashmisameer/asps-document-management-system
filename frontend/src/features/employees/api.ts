import type {
  CreateEmployeeInput,
  DocumentType,
  EmployeeDocument,
  EmployeeListItem,
  EmployeeListQuery,
  Employee,
  EmployeeProfile,
  MarkEmployeeLeftInput,
  Paginated,
  UpdateEmployeeInput,
} from '@asps-dms/shared'
import { api } from '../../lib/api.js'
import { fileFromResponse, type DownloadedFile } from '../../lib/download.js'

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

/**
 * Records that an employee has left.
 *
 * Its own endpoint and its own permission, separate from archiving: leaving the
 * company and the office being finished with the record are different things,
 * and someone who has left is normally not archived at all.
 */
export async function markEmployeeLeft(
  employeeId: number,
  input: MarkEmployeeLeftInput,
): Promise<EmployeeProfile> {
  const response = await api.post<{ employee: EmployeeProfile }>(
    `/employees/${employeeId}/exit`,
    input,
  )
  return response.data.employee
}

/** Undoes an exit recorded by mistake. The audit trail keeps both halves. */
export async function undoEmployeeExit(employeeId: number): Promise<EmployeeProfile> {
  const response = await api.delete<{ employee: EmployeeProfile }>(
    `/employees/${employeeId}/exit`,
  )
  return response.data.employee
}

/**
 * The checklist's document types.
 *
 * Active ones by default - a retired type must not appear in a filter or on a
 * form. Settings asks for all of them, because taking a document off the list
 * is done there and a screen that hid the result would leave nowhere to put it
 * back.
 */
export async function listDocumentTypes(includeInactive = false): Promise<DocumentType[]> {
  const response = await api.get<{ documentTypes: DocumentType[] }>('/document-types', {
    params: includeInactive ? { includeInactive: true } : undefined,
  })
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

export interface ReferenceLists {
  departments: string[]
  designations: string[]
}

/**
 * The lists the employee form offers.
 *
 * Cached for the session: 26 departments and 49 designations do not change
 * while somebody is filling in a form.
 */
export async function fetchReference(): Promise<ReferenceLists> {
  const response = await api.get<{ reference: ReferenceLists }>('/reference')
  return response.data.reference
}

export const referenceKeys = {
  all: ['reference'] as const,
}

/**
 * How long a print may take.
 *
 * Well past the general 30 seconds. A print of a hundred forms reads a hundred
 * employees, their checklists and their photographs one at a time, and a
 * request cut off while the server is still drawing it looks to the person at
 * the printer exactly like a failure - when what actually happened is that they
 * asked for a lot of paper.
 */
const PRINT_TIMEOUT_MS = 120_000

/** The name comes from the SERVER - employee code and name, or the day of a bulk print. */
export type PrintedForms = DownloadedFile

/**
 * Every document this employee has sent in, bound into one PDF.
 *
 * The same long timeout as a print: this reads every file the employee has
 * filed and merges them, and a bundle of ten scans is tens of megabytes of
 * work before a byte comes back.
 */
export async function downloadEmployeeDocuments(employeeId: number): Promise<DownloadedFile> {
  const response = await api.get<Blob>(`/employees/${employeeId}/documents/download`, {
    responseType: 'blob',
    timeout: PRINT_TIMEOUT_MS,
  })
  return fileFromResponse(response, 'employee-documents.pdf')
}

/** One employee's form. */
export async function printEmployeeForm(employeeId: number): Promise<PrintedForms> {
  const response = await api.get<Blob>(`/employees/${employeeId}/print`, {
    responseType: 'blob',
    timeout: PRINT_TIMEOUT_MS,
  })
  return fileFromResponse(response, 'employee-form.pdf')
}

/**
 * Several employees' forms, in ONE PDF with each of them on their own page.
 *
 * One file rather than a download per employee: a browser asked for twenty
 * downloads at once blocks most of them, and twenty files is twenty print
 * dialogues for somebody who wanted one stack of paper.
 */
export async function printEmployeeForms(
  employeeIds: readonly number[],
): Promise<PrintedForms> {
  const response = await api.post<Blob>(
    '/employees/print',
    { employeeIds },
    { responseType: 'blob', timeout: PRINT_TIMEOUT_MS },
  )
  return fileFromResponse(response, 'employee-forms.pdf')
}
