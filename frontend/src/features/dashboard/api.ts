import { api } from '../../lib/api.js'

/** The dashboard numbers, in one request so the tiles cannot disagree. */

export interface DashboardSummary {
  employees: {
    total: number
    male: number
    female: number
    other: number
    notRecorded: number
    archived: number
    /** Active plus left, with the archived records left out. */
    activeAndLeft: number
    joinedLast30Days: number
    left: number
    leftThisYear: number
  }
  documents: {
    total: number
    received: number
    verified: number
    pending: number
    overdue: number
    dueSoon: number
  }
  /** Active employees by whether their whole checklist is in. They add up to employees.total. */
  checklists: {
    complete: number
    incomplete: number
  }
  employeesMissingMandatory: number
  signatures: {
    awaiting: number
    employeesWithoutSignature: number
  }
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const response = await api.get<{ summary: DashboardSummary }>('/dashboard/summary')
  return response.data.summary
}

export const dashboardKeys = {
  summary: ['dashboard', 'summary'] as const,
}
