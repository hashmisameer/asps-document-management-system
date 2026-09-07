import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMPLOYEE_FILTERS,
  activeFilterChips,
  archivedAreShown,
  employeeFiltersToSearch,
  employmentChoiceFilters,
  employmentChoiceOf,
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

/**
 * The Employment dropdown, and the archived.
 *
 * Reported from the office on 2026-09-07: 549 employees, all active, none
 * archived. The third option on the dropdown listed all 549; archive one and it
 * listed 548 - the opposite of what somebody choosing it expected.
 *
 * The dropdown had no Archived option at all. It had 'All', which does mean
 * everybody-whose-record-is-live and did exactly that. The fix is a fourth
 * option that asks the question people were trying to ask, and these tests hold
 * the two axes apart: whether somebody is still HERE, and whether their RECORD
 * has been archived.
 */
describe('the Employment dropdown', () => {
  it('shows the option that matches what the list is doing', () => {
    expect(employmentChoiceOf(read(''))).toBe('active')
    expect(employmentChoiceOf(read('?status=left'))).toBe('left')
    expect(employmentChoiceOf(read('?status=all'))).toBe('all')
    expect(employmentChoiceOf(read('?archivedOnly=true&status=all'))).toBe('archived')
  })

  it('shows Archived however the employment half was left', () => {
    // What the dashboard's Archived tile links to, and what somebody lands on
    // after switching from Left. archivedOnly is what the list is showing, so
    // that is what the control has to say.
    expect(employmentChoiceOf(read('?archivedOnly=true&status=left'))).toBe('archived')
    expect(employmentChoiceOf(read('?archivedOnly=true'))).toBe('archived')
  })

  it('asks for ONLY the archived when Archived is chosen', () => {
    // The bug as reported. One archived employee out of 549 must give a list of
    // one, not of 548.
    expect(employmentChoiceFilters('archived')).toEqual({ status: 'all', archivedOnly: true })
  })

  it('sets the employment half aside under Archived, rather than guessing', () => {
    // An archived record may belong to somebody who left in 2019 or to somebody
    // still on the floor who was archived by mistake. Holding 'active' as well
    // would hide half of them.
    const query = toEmployeeListQuery(
      { ...DEFAULT_EMPLOYEE_FILTERS, ...employmentChoiceFilters('archived') },
      25,
    )

    expect(query).toMatchObject({ archivedOnly: true, status: 'all' })
  })

  it('stops asking for the archived as soon as another option is chosen', () => {
    // Leaving archivedOnly set behind would answer 'Active' with an empty list
    // and nothing on the screen to explain it.
    for (const choice of ['active', 'left', 'all'] as const) {
      expect(employmentChoiceFilters(choice), choice).toEqual({
        status: choice,
        archivedOnly: false,
      })
    }
  })

  it('round-trips: choose Archived, then Active, and the archived are gone again', () => {
    const archived = { ...DEFAULT_EMPLOYEE_FILTERS, ...employmentChoiceFilters('archived') }
    const back = { ...archived, ...employmentChoiceFilters('active') }

    expect(employmentChoiceOf(archived)).toBe('archived')
    expect(back).toMatchObject({ status: 'active', archivedOnly: false })
    expect(employmentChoiceOf(back)).toBe('active')
  })
})

describe('the Include archived checkbox', () => {
  it('is the same axis as the dropdown: hidden, alongside, or on their own', () => {
    expect(archivedAreShown(read(''))).toBe(false)
    expect(archivedAreShown(read('?includeArchived=true'))).toBe(true)
    // Ticked, because the archived are not merely included - they are all
    // there is. The page shows it disabled at this point for the same reason.
    expect(archivedAreShown(read('?archivedOnly=true&status=all'))).toBe(true)
  })

  it('leaves the checkbox alone while Archived is chosen, so it comes back', () => {
    // Somebody who had ticked it, looked at the archived, and went back to
    // Active should find their list as they left it.
    const ticked = { ...DEFAULT_EMPLOYEE_FILTERS, includeArchived: true }
    const archived = { ...ticked, ...employmentChoiceFilters('archived') }

    expect(archived.includeArchived).toBe(true)
    expect({ ...archived, ...employmentChoiceFilters('active') }).toMatchObject({
      includeArchived: true,
      archivedOnly: false,
    })
  })

  it('does not put a chip under a filter the dropdown now shows', () => {
    // Two controls for one filter, and clearing either one leaves the other
    // saying something the list is not doing.
    expect(activeFilterChips(read('?archivedOnly=true&status=all'))).toHaveLength(0)
  })
})
