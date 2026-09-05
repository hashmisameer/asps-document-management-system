import { createRequest } from '../database/pool.js'

/**
 * The lists the employee form offers: departments and designations.
 *
 * Both in one round trip, because one form needs both and two requests would
 * have the second arrive after somebody had already started typing.
 *
 * Only the active ones. A department that has closed stops being offered
 * without erasing the employees who worked in it - their record still says
 * where they were, which is the point of storing the name rather than a key.
 */

export interface ReferenceLists {
  departments: string[]
  designations: string[]
}

export async function listReference(): Promise<ReferenceLists> {
  const request = await createRequest()
  const result = await request.query<{ Kind: string; Name: string }>(`
    SELECT 'department' AS Kind, Name FROM dbo.Departments  WHERE IsActive = 1
    UNION ALL
    SELECT 'designation' AS Kind, Name FROM dbo.Designations WHERE IsActive = 1
    ORDER BY Kind, Name
  `)

  return {
    departments: result.recordset.filter((r) => r.Kind === 'department').map((r) => r.Name),
    designations: result.recordset.filter((r) => r.Kind === 'designation').map((r) => r.Name),
  }
}
