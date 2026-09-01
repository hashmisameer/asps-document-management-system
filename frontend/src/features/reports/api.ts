import { api } from '../../lib/api.js'

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
}
