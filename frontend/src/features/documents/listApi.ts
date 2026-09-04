import type {
  DeadlineState,
  DeadlineUnit,
  DocumentListQuery,
  DocumentListState,
  DocumentStatus,
  Paginated,
} from '@asps-dms/shared'
import { api } from '../../lib/api.js'

/**
 * The documents list: every checklist row in the company, filtered.
 *
 * A row here is one document expected of one employee, which is what the
 * dashboard's document tiles count. 'Still to come 57' is fifty-seven of these,
 * spread over fewer people than that.
 */

export interface DocumentListItem {
  documentId: number
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  documentTypeId: number
  documentName: string
  isMandatory: boolean
  status: DocumentStatus
  /** A file is attached - whatever review it is at. */
  hasFile: boolean
  dueDate: string | null
  /** How the deadline is counted back on screen: days, or months. */
  deadlineUnit: DeadlineUnit | null
  uploadedAt: string | null
  deadlineState: DeadlineState
  /** Positive = days remaining. Negative = days overdue. Null = no deadline. */
  daysRemaining: number | null
}

export type DocumentListParams = Partial<DocumentListQuery>

export async function listDocuments(
  params: DocumentListParams,
): Promise<Paginated<DocumentListItem>> {
  const response = await api.get<Paginated<DocumentListItem>>('/documents', { params })
  return response.data
}

export const documentListKeys = {
  all: ['documents', 'list'] as const,
  list: (params: DocumentListParams) => [...documentListKeys.all, params] as const,
}

/** How each state reads as a page heading and in the sentence under it. */
export const DOCUMENT_STATE_LABEL: Readonly<Record<DocumentListState, string>> = {
  all: 'All documents',
  received: 'Received documents',
  pending: 'Documents still to come',
  overdue: 'Overdue documents',
  dueSoon: 'Due in the next 7 days',
}

export const DOCUMENT_STATE_DESCRIPTION: Readonly<Record<DocumentListState, string>> = {
  all: 'Every document expected of a current employee.',
  received: 'A file has arrived for these, whatever review it is at.',
  pending: 'No file yet. One line per document, not per employee.',
  overdue: 'Past their date and still not in.',
  dueSoon: 'Deadlines falling within the next seven days, including today.',
}
