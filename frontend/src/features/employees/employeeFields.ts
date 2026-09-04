import {
  EMPLOYMENT_STATUSES,
  EXIT_REASON_LABEL,
  GENDERS,
  type EmployeeProfile,
} from '@asps-dms/shared'
import { formatDate } from '../../lib/format.js'

/**
 * Every detail an employee record holds, described once.
 *
 * The form and the profile used to carry their own lists, and they drifted: the
 * form asked for a date of birth, a mobile number, an address and a gender that
 * the profile never showed, so somebody could fill a field in and then be unable
 * to find it again. That is the failure this file exists to prevent - adding a
 * field here puts it on BOTH screens, and there is nowhere to add it to only one.
 *
 * The profile renders every field in this list, grouped. The form renders the
 * ones marked editable. Neither keeps a list of its own.
 */

export type EmployeeFieldGroup = 'Identity' | 'Employment' | 'Contact' | 'Exit'

export const EMPLOYEE_FIELD_GROUPS: readonly EmployeeFieldGroup[] = [
  'Identity',
  'Employment',
  'Contact',
  'Exit',
]

export interface EmployeeField {
  /** Matches the form's value key and the profile's property. */
  key: string
  label: string
  group: EmployeeFieldGroup
  /** What the form draws for it. 'none' means the profile shows it and the form does not. */
  input: 'text' | 'date' | 'select' | 'none'
  required: boolean
  /** Free text under the input. */
  hint?: string
  /** For 'select'. */
  options?: readonly string[]
  /**
   * Set on a field the form must never offer for editing.
   *
   * The employee code is the only one: it is what documents are matched
   * against, and the form itself tells whoever types it that it cannot be
   * changed later.
   */
  immutable?: boolean
  /** Only shown once the employee has actually left. */
  onlyWhenLeft?: boolean
  /** How it reads on the profile. */
  display: (profile: EmployeeProfile) => string
}

/** An empty value reads as a dash, so the row still says the field exists. */
const orDash = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === '' ? '—' : value

const dateOrDash = (value: string | null): string => (value === null ? '—' : formatDate(value))

export const EMPLOYEE_FIELDS: readonly EmployeeField[] = [
  {
    key: 'employeeCode',
    label: 'Employee ID',
    group: 'Identity',
    input: 'text',
    required: true,
    immutable: true,
    hint: "The company's own number, as printed on the service card. It cannot be changed later.",
    display: (p) => p.employeeCode,
  },
  {
    key: 'employeeName',
    label: 'Employee name',
    group: 'Identity',
    input: 'text',
    required: true,
    display: (p) => p.employeeName,
  },
  {
    key: 'dateOfBirth',
    label: 'Date of birth',
    group: 'Identity',
    input: 'date',
    required: false,
    display: (p) => dateOrDash(p.dateOfBirth),
  },
  {
    key: 'gender',
    label: 'Gender',
    group: 'Identity',
    input: 'select',
    required: false,
    options: GENDERS,
    display: (p) => orDash(p.gender),
  },

  {
    key: 'joiningDate',
    label: 'Joining date',
    group: 'Employment',
    input: 'date',
    required: true,
    hint: 'Document deadlines are calculated from this date.',
    display: (p) => dateOrDash(p.joiningDate),
  },
  {
    key: 'department',
    label: 'Department',
    group: 'Employment',
    input: 'select',
    required: false,
    display: (p) => orDash(p.department),
  },
  {
    key: 'designation',
    label: 'Designation',
    group: 'Employment',
    input: 'select',
    required: false,
    display: (p) => orDash(p.designation),
  },
  {
    // Not editable here: it follows from the exit dates, and typing it directly
    // would let the record say someone had left with no date saying when.
    key: 'employmentStatus',
    label: 'Employment status',
    group: 'Employment',
    input: 'none',
    required: false,
    display: (p) => (p.employmentStatus === EMPLOYMENT_STATUSES.LEFT ? 'Left' : 'Active'),
  },

  {
    key: 'phoneNumber',
    label: 'Mobile number',
    group: 'Contact',
    input: 'text',
    required: false,
    hint: 'Ten digits.',
    display: (p) => orDash(p.phoneNumber),
  },
  {
    key: 'email',
    label: 'Email',
    group: 'Contact',
    input: 'text',
    required: false,
    hint: 'Optional - most workmen are reached by telephone.',
    display: (p) => orDash(p.email),
  },
  {
    key: 'address',
    label: 'Address',
    group: 'Contact',
    input: 'text',
    required: false,
    hint: "As written on the employee's own forms.",
    display: (p) => orDash(p.address),
  },

  // Recorded by 'Mark as Left', never typed on this form.
  {
    key: 'resignationDate',
    label: 'Resignation date',
    group: 'Exit',
    input: 'none',
    required: false,
    onlyWhenLeft: true,
    display: (p) => dateOrDash(p.resignationDate),
  },
  {
    key: 'lastWorkingDate',
    label: 'Last working date',
    group: 'Exit',
    input: 'none',
    required: false,
    onlyWhenLeft: true,
    display: (p) => dateOrDash(p.lastWorkingDate),
  },
  {
    key: 'exitReason',
    label: 'Reason',
    group: 'Exit',
    input: 'none',
    required: false,
    onlyWhenLeft: true,
    display: (p) => (p.exitReason ? EXIT_REASON_LABEL[p.exitReason] : '—'),
  },
  {
    key: 'exitNotes',
    label: 'Notes',
    group: 'Exit',
    input: 'none',
    required: false,
    onlyWhenLeft: true,
    display: (p) => orDash(p.exitNotes),
  },
]

/** The fields the form draws, in order. */
export const EDITABLE_EMPLOYEE_FIELDS = EMPLOYEE_FIELDS.filter((field) => field.input !== 'none')

/**
 * The fields a profile shows for this employee.
 *
 * Everything except the exit details of somebody who has not left - those would
 * be four dashes explaining nothing. Every other empty field IS shown, as a
 * dash, because a row that disappears when empty is a field nobody knows to
 * fill in.
 */
export function visibleFieldsFor(profile: EmployeeProfile): readonly EmployeeField[] {
  const hasLeft = profile.resignationDate !== null
  return EMPLOYEE_FIELDS.filter((field) => !field.onlyWhenLeft || hasLeft)
}
