import { describe, expect, it } from 'vitest'
import { ROLES } from '@asps-dms/shared'
import { visibleNavItems } from '../../src/app/navigation.js'

const labels = (role: Parameters<typeof visibleNavItems>[0]) =>
  visibleNavItems(role).map((item) => item.label)

describe('navigation', () => {
  it('shows user management to Admin only', () => {
    expect(labels(ROLES.ADMIN)).toContain('Users')
    expect(labels(ROLES.HR)).not.toContain('Users')
    expect(labels(ROLES.VIEWER)).not.toContain('Users')
  })

  it('gives a Viewer the read-only pages', () => {
    expect(labels(ROLES.VIEWER)).toEqual(['Dashboard', 'Employees', 'Reports'])
  })

  it('offers no Settings, to anybody', () => {
    // The checklist is decided in code - see documentChecklist.ts - and the
    // email goes to the addresses in .env. There is nothing left to configure
    // on a screen, and a screen that can change the checklist is one somebody
    // changes by accident.
    for (const role of [ROLES.HR, ROLES.VIEWER, ROLES.ADMIN]) {
      expect(labels(role)).not.toContain('Settings')
    }
  })

  it('shows nothing at all when signed out', () => {
    expect(visibleNavItems(null)).toEqual([])
  })

  it('always includes the dashboard for a signed-in user', () => {
    for (const role of [ROLES.HR, ROLES.VIEWER, ROLES.ADMIN]) {
      expect(labels(role)[0]).toBe('Dashboard')
    }
  })
})
