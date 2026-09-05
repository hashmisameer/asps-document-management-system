import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMPLOYEE_FILTERS,
  activeFilterChips,
  employeeFiltersToSearch,
  readEmployeeFilters,
  toEmployeeListQuery,
} from '../../src/features/employees/listParams.js'

/**
 * The employee list's filters, as they travel through the URL.
 *
 * This is what makes a dashboard tile able to open a filtered list at all: the
 * page reads its filters from the address rather than from state, so clicking a
 * second tile changes what is on screen instead of only the address bar.
 */

const read = (search: string) => readEmployeeFilters(new URLSearchParams(search))

describe('reading filters out of a URL', () => {
  it('defaults to those still here, unarchived', () => {
    expect(read('')).toEqual(DEFAULT_EMPLOYEE_FILTERS)
  })

  it('reads every filter a dashboard tile can set', () => {
    expect(read('?missingIdCard=true')).toMatchObject({ missingIdCard: true, status: 'active' })
    expect(read('?withoutSignature=true')).toMatchObject({ withoutSignature: true })
    expect(read('?gender=notRecorded')).toMatchObject({ gender: 'notRecorded' })
    expect(read('?archivedOnly=true&status=all')).toMatchObject({
      archivedOnly: true,
      status: 'all',
    })
    expect(read('?status=left&leftThisYear=true&includeArchived=true')).toMatchObject({
      status: 'left',
      leftThisYear: true,
      includeArchived: true,
    })
  })

  it('ignores values the API would refuse, rather than passing them on', () => {
    // A typed or stale URL is a mistake, not an error page.
    expect(read('?status=nonsense').status).toBe('active')
    expect(read('?gender=Wizard').gender).toBe('')
    expect(read('?sortBy=DROP TABLE').sortBy).toBe('employeeName')
    expect(read('?page=0').page).toBe(1)
    expect(read('?page=-4').page).toBe(1)
    expect(read('?page=two').page).toBe(1)
  })

  it("treats 'false' as false, the way the server does", () => {
    // A browser sends 'false' for a flag that is off, and JavaScript truthiness
    // would read that as on.
    expect(read('?missingIdCard=false').missingIdCard).toBe(false)
    expect(read('?includeArchived=0').includeArchived).toBe(false)
    expect(read('?includeArchived=on').includeArchived).toBe(true)
  })
})

describe('writing filters back into a URL', () => {
  it('leaves out everything still at its default, so the link stays readable', () => {
    expect(employeeFiltersToSearch(DEFAULT_EMPLOYEE_FILTERS).toString()).toBe('')
  })

  it('round-trips every filter it writes', () => {
    const filters = {
      ...DEFAULT_EMPLOYEE_FILTERS,
      department: 'JACKET FRONT',
      status: 'left' as const,
      gender: 'Female' as const,
      joinedWithin: 'month' as const,
      includeArchived: true,
      leftThisYear: true,
      sortBy: 'joiningDate' as const,
      sortDir: 'desc' as const,
      page: 3,
    }

    expect(readEmployeeFilters(employeeFiltersToSearch(filters))).toEqual(filters)
  })
})

describe('the chips that explain a short list', () => {
  it('names the filters that have no control on the toolbar', () => {
    const chips = activeFilterChips(read('?missingIdCard=true'))

    expect(chips.map((chip) => chip.label)).toEqual(['Missing an ID card'])
  })

  it('says nothing when the toolbar already shows the filter', () => {
    // Department and employment status have their own controls; a chip for
    // those would be the same fact twice.
    expect(activeFilterChips(read('?department=CUTTING&status=left'))).toHaveLength(0)
  })

  it('clears the one filter it names and leaves the rest alone', () => {
    const filters = read('?gender=Female&missingIdCard=true')
    const chip = activeFilterChips(filters).find((candidate) => candidate.key === 'gender')

    expect(chip?.label).toBe('Women')
    expect({ ...filters, ...chip?.clears }).toMatchObject({ gender: '', missingIdCard: true })
  })
})

describe('the query the API is asked', () => {
  it('carries the filters through unchanged', () => {
    const query = toEmployeeListQuery(read('?gender=Male&department=FUSING'), 25)

    expect(query).toMatchObject({
      gender: 'Male',
      department: 'FUSING',
      status: 'active',
      pageSize: 25,
      page: 1,
    })
  })

  it('sends nothing for a filter that was not set', () => {
    const query = toEmployeeListQuery(DEFAULT_EMPLOYEE_FILTERS, 25)

    expect(query).not.toHaveProperty('gender')
    expect(query).not.toHaveProperty('department')
    expect(query).not.toHaveProperty('search')
  })
})
