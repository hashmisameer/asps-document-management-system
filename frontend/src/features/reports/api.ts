import type { ExitReason } from '@asps-dms/shared'
import { api } from '../../lib/api.js'
import { fileFromResponse, type DownloadedFile } from '../../lib/download.js'

/** The reports. Read-only; nothing here changes anything. */

export interface DocumentTypeReportRow {
  documentTypeId: number
  documentName: string
  isMandatory: boolean
  expected: number
  received: number
  outstanding: number
  overdue: number
}

export interface OutstandingReportRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  joiningDate: string
  outstanding: number
  overdue: number
  /** The outstanding documents, named and comma-separated. */
  documents: string
}

export interface OutstandingReport {
  rows: OutstandingReportRow[]
  /** True when more employees matched than the report will return. */
  truncated: boolean
}

/** One employee who has left. */
export interface ExitReportRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  joiningDate: string
  resignationDate: string
  lastWorkingDate: string
  exitReason: ExitReason
  /** Counting the first day and the last, so a single-day stint is 1. */
  daysWorked: number
  /** False while they are still working their notice period. */
  hasGone: boolean
}

export interface ExitsByDepartmentRow {
  department: string | null
  exits: number
}

export interface ExitReport {
  exits: ExitReportRow[]
  byDepartment: ExitsByDepartmentRow[]
}

export async function fetchExits(): Promise<ExitReport> {
  const response = await api.get<ExitReport>('/reports/exits')
  return response.data
}

export interface OutstandingFilters {
  department?: string
  onlyOverdue?: boolean
  onlyMandatory?: boolean
}

export async function fetchByDocumentType(): Promise<DocumentTypeReportRow[]> {
  const response = await api.get<{ rows: DocumentTypeReportRow[] }>('/reports/by-document-type')
  return response.data.rows
}

export async function fetchOutstanding(filters: OutstandingFilters): Promise<OutstandingReport> {
  const response = await api.get<OutstandingReport>('/reports/outstanding', { params: filters })
  return response.data
}

export const reportKeys = {
  byDocumentType: ['reports', 'by-document-type'] as const,
  outstanding: (filters: OutstandingFilters) => ['reports', 'outstanding', filters] as const,
  exits: ['reports', 'exits'] as const,
  documentEmployees: (documentTypeId: number, filters: DocumentEmployeeFilters) =>
    ['reports', 'document-employees', documentTypeId, filters] as const,
}

/** One employee on the drill-down behind a by-document row. */
export interface DocumentEmployeeRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  state: 'Received' | 'Overdue' | 'Pending'
  dueDate: string | null
  /** Positive when overdue, negative when still due, null with no deadline. */
  daysOverdue: number | null
}

export type DocumentEmployeeSortKey =
  | 'employeeName'
  | 'employeeCode'
  | 'department'
  | 'designation'
  | 'dueDate'
  | 'daysOverdue'

export interface DocumentEmployeeFilters {
  outstandingOnly?: boolean
  onlyOverdue?: boolean
  department?: string
  sortBy?: DocumentEmployeeSortKey
  sortDir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface DocumentEmployeePage {
  rows: DocumentEmployeeRow[]
  total: number
  page: number
  pageSize: number
}

export async function fetchEmployeesForDocumentType(
  documentTypeId: number,
  filters: DocumentEmployeeFilters,
): Promise<DocumentEmployeePage> {
  const response = await api.get<DocumentEmployeePage>(
    `/reports/by-document-type/${documentTypeId}/employees`,
    { params: filters },
  )
  return response.data
}

/**
 * The same list as a PDF, built by the server.
 *
 * The PAGE AND PAGE SIZE ARE DELIBERATELY NOT SENT. The endpoint prints every
 * employee the filters match, which is the point of it: the CSV is what gets
 * forwarded, and this is what gets carried round and ticked off.
 */
export async function printDocumentEmployeeList(
  documentTypeId: number,
  filters: DocumentEmployeeFilters,
): Promise<DownloadedFile> {
  const { page: _page, pageSize: _pageSize, ...printable } = filters

  const response = await api.get<Blob>(
    `/reports/by-document-type/${documentTypeId}/employees/print`,
    {
      params: printable,
      responseType: 'blob',
      // A list of every outstanding employee for one document is a bigger read
      // than a screenful, and it is drawn as well as read.
      timeout: 120_000,
    },
  )

  return fileFromResponse(response, 'document-list.pdf')
}