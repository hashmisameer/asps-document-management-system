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
    joinedLast30Days: number
  }
  documents: {
    total: number
    received: number
    verified: number
    pending: number
    overdue: number
    dueSoon: number
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
