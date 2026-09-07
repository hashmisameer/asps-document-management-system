import {
  EMPLOYEE_STATUS_FILTERS,
  type EmployeeSortKey,
  type EmployeeStatusFilter,
  type GenderFilter,
  type JoinedWithinPeriod,
} from '@asps-dms/shared'
import type { EmployeeListParams } from './api.js'

/**
 * The employee list's filters, held in the URL.
 *
 * The URL rather than component state, for one reason: the dashboard opens this
 * page with filters already applied. With the filters in state, '/employees?
 * status=left' and '/employees?gender=Female' are the same component instance
 * with different search strings - React Router does not remount it - so the
 * second tile somebody clicks would change the address bar and nothing else.
 *
 * It pays for itself twice over: a filtered list can be sent to somebody, and
 * the browser's Back button walks back through the filters instead of leaving
 * the page.
 *
 * Kept out of the component so the reading and writing can be tested as
 * functions, which is where the mistakes in this kind of code live.
 */

export interface EmployeeFilters {
  search: string
  department: string
  status: EmployeeStatusFilter
  joinedWithin: JoinedWithinPeriod | ''
  includeArchived: boolean
  /** Archived records ONLY - what the dashboard's Archived tile opens. */
  archivedOnly: boolean
  gender: GenderFilter | ''
  missingIdCard: boolean
  withoutSignature: boolean
  leftThisYear: boolean
  /** Whether their whole checklist is in - what the two Documents cards open. */
  checklist: 'complete' | 'incomplete' | ''
  sortBy: EmployeeSortKey
  sortDir: 'asc' | 'desc'
  page: number
}

export const DEFAULT_EMPLOYEE_FILTERS: EmployeeFilters = {
  search: '',
  department: '',
  // Those still here, by default. Nothing is hidden that a single click does
  // not bring back, and no filter removes a row from the database.
  status: EMPLOYEE_STATUS_FILTERS.ACTIVE,
  joinedWithin: '',
  includeArchived: false,
  archivedOnly: false,
  gender: '',
  missingIdCard: false,
  withoutSignature: false,
  leftThisYear: false,
  checklist: '',
  sortBy: 'employeeName',
  sortDir: 'asc',
  page: 1,
}

/* -------------------------------------------------------------------------- */
/* The Employment control                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the toolbar's Employment dropdown offers.
 *
 * Two different questions are being asked through one control, and keeping them
 * straight is the whole point of these three functions.
 *
 *   Active / Left / All  ask about the PERSON: are they still here.
 *   Archived             asks about the RECORD: has the office finished with it.
 *
 * They are not alternatives. Somebody who left in 2019 has both left AND been
 * archived; somebody archived by mistake may still be working. So 'Archived'
 * does not mean a fourth employment status - it means archivedOnly, with the
 * employment question set aside ('all'), which is exactly what the dashboard's
 * Archived tile has always linked to.
 *
 * The 'Include archived' checkbox is the third state of the same axis: hidden
 * (default), alongside the rest (checkbox), or on their own (Archived). While
 * Archived is chosen the checkbox has nothing left to say - archived records
 * are all that is being listed - so the page shows it ticked and disabled
 * rather than letting somebody set a flag that changes nothing.
 */
export type EmploymentChoice = EmployeeStatusFilter | 'archived'

export const ARCHIVED_CHOICE = 'archived'

/** Which option the dropdown should be showing, given the filters in the URL. */
export function employmentChoiceOf(
  filters: Pick<EmployeeFilters, 'status' | 'archivedOnly'>,
): EmploymentChoice {
  // archivedOnly wins, because it is what the LIST is actually showing - the
  // server applies it ahead of everything else on this axis.
  return filters.archivedOnly ? ARCHIVED_CHOICE : filters.status
}

/** What choosing an option sets. Always both, so neither can be left behind. */
export function employmentChoiceFilters(
  choice: EmploymentChoice,
): Pick<EmployeeFilters, 'status' | 'archivedOnly'> {
  return choice === ARCHIVED_CHOICE
    ? { status: EMPLOYEE_STATUS_FILTERS.ALL, archivedOnly: true }
    : // Moving off Archived clears archivedOnly. Leaving it set would answer
      // 'Active' with an empty list and nothing on screen to explain it.
      { status: choice, archivedOnly: false }
}

/** Whether archived records are in this list - what the checkbox shows. */
export function archivedAreShown(
  filters: Pick<EmployeeFilters, 'includeArchived' | 'archivedOnly'>,
): boolean {
  return filters.archivedOnly || filters.includeArchived
}

const STATUSES: readonly string[] = Object.values(EMPLOYEE_STATUS_FILTERS)
const PERIODS: readonly string[] = ['week', 'month', 'sixMonths', 'year']
const GENDERS: readonly string[] = ['Male', 'Female', 'Other', 'notRecorded']
const CHECKLIST_STATES: readonly string[] = ['complete', 'incomplete']
const SORT_KEYS: readonly string[] = [
  'documentsPending',
  'employeeCode',
  'employeeName',
  'joiningDate',
  'department',
  'designation',
  'createdAt',
]

/** True only for the spellings the API accepts, so a typed URL cannot be a filter. */
const flag = (value: string | null): boolean =>
  value !== null && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())

function oneOf<T extends string>(value: string | null, allowed: readonly string[], fallback: T): T {
  return value !== null && allowed.includes(value) ? (value as T) : fallback
}

export function readEmployeeFilters(params: URLSearchParams): EmployeeFilters {
  const page = Number(params.get('page'))

  return {
    search: params.get('search')?.trim() ?? '',
    department: params.get('department') ?? '',
    status: oneOf(params.get('status'), STATUSES, DEFAULT_EMPLOYEE_FILTERS.status),
    joinedWithin: oneOf<JoinedWithinPeriod | ''>(params.get('joinedWithin'), PERIODS, ''),
    includeArchived: flag(params.get('includeArchived')),
    archivedOnly: flag(params.get('archivedOnly')),
    gender: oneOf<GenderFilter | ''>(params.get('gender'), GENDERS, ''),
    missingIdCard: flag(params.get('missingIdCard')),
    withoutSignature: flag(params.get('withoutSignature')),
    leftThisYear: flag(params.get('leftThisYear')),
    checklist: oneOf<'complete' | 'incomplete' | ''>(
      params.get('checklist'),
      CHECKLIST_STATES,
      '',
    ),
    sortBy: oneOf(params.get('sortBy'), SORT_KEYS, DEFAULT_EMPLOYEE_FILTERS.sortBy),
    sortDir: params.get('sortDir') === 'desc' ? 'desc' : 'asc',
    // A page number that is not a number is page one, not an empty screen.
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

/**
 * The filters as a query string, with everything left at its default omitted.
 *
 * A short URL is one somebody can read and send. It also keeps the address bar
 * honest: what is written there is what was actually chosen.
 */
export function employeeFiltersToSearch(filters: EmployeeFilters): URLSearchParams {
  const params = new URLSearchParams()
  const put = (key: keyof EmployeeFilters, value: string): void => {
    if (value !== '' && value !== String(DEFAULT_EMPLOYEE_FILTERS[key])) params.set(key, value)
  }

  put('search', filters.search)
  put('department', filters.department)
  put('status', filters.status)
  put('joinedWithin', filters.joinedWithin)
  put('gender', filters.gender)
  put('checklist', filters.checklist)
  put('sortBy', filters.sortBy)
  put('sortDir', filters.sortDir)

  for (const key of ['includeArchived', 'archivedOnly', 'missingIdCard', 'withoutSignature', 'leftThisYear'] as const) {
    if (filters[key]) params.set(key, 'true')
  }

  if (filters.page > 1) params.set('page', String(filters.page))

  return params
}

/** The filters as the API's query parameters. */
export function toEmployeeListQuery(
  filters: EmployeeFilters,
  pageSize: number,
): EmployeeListParams {
  return {
    page: filters.page,
    pageSize,
    sortBy: filters.sortBy,
    sortDir: filters.sortDir,
    status: filters.status,
    includeArchived: filters.includeArchived,
    archivedOnly: filters.archivedOnly,
    missingIdCard: filters.missingIdCard,
    withoutSignature: filters.withoutSignature,
    leftThisYear: filters.leftThisYear,
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.department ? { department: filters.department } : {}),
    ...(filters.joinedWithin ? { joinedWithin: filters.joinedWithin } : {}),
    ...(filters.gender ? { gender: filters.gender } : {}),
    ...(filters.checklist ? { checklist: filters.checklist } : {}),
  }
}

/**
 * The filters that have no control on the toolbar, named so they can be seen
 * and removed.
 *
 * Without this a list opened from a dashboard tile is simply short, with
 * nothing on the screen saying why - which reads as missing employees rather
 * than as a filter. Each chip carries the change that clears it.
 */
export interface FilterChip {
  key: string
  label: string
  clears: Partial<EmployeeFilters>
}

const GENDER_CHIP_LABEL: Readonly<Record<string, string>> = {
  Male: 'Men',
  Female: 'Women',
  Other: 'Other',
  notRecorded: 'Gender not recorded',
}

export function activeFilterChips(filters: EmployeeFilters): FilterChip[] {
  const chips: FilterChip[] = []

  if (filters.gender) {
    chips.push({
      key: 'gender',
      label: GENDER_CHIP_LABEL[filters.gender] ?? filters.gender,
      clears: { gender: '' },
    })
  }
  if (filters.missingIdCard) {
    chips.push({
      key: 'missingIdCard',
      label: 'Missing an ID card',
      clears: { missingIdCard: false },
    })
  }
  if (filters.withoutSignature) {
    chips.push({
      key: 'withoutSignature',
      label: 'Pending employee signature',
      clears: { withoutSignature: false },
    })
  }
  if (filters.leftThisYear) {
    chips.push({ key: 'leftThisYear', label: 'Left this year', clears: { leftThisYear: false } })
  }
  /* No chip for archivedOnly: the Employment dropdown shows it now. A chip as
     well would be two controls for one filter, and clearing one of them would
     leave the other saying something the list is not doing. */
  if (filters.checklist) {
    chips.push({
      key: 'checklist',
      label:
        filters.checklist === 'complete' ? 'Checklist complete' : 'Checklist incomplete',
      clears: { checklist: '' },
    })
  }

  return chips
}
