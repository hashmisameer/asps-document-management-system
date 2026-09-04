import { describe, expect, it } from 'vitest'
import type { DashboardSummary } from '../../src/features/dashboard/api.js'
import {
  documentTiles,
  employeeTiles,
  genderSlices,
  needsAttentionTiles,
} from '../../src/features/dashboard/tiles.js'
import {
  readEmployeeFilters,
  toEmployeeListQuery,
} from '../../src/features/employees/listParams.js'

/**
 * What each dashboard tile shows, and what it opens.
 *
 * The pairing is the whole point: a tile's number and its link's filters have to
 * describe the same set of rows, or the office clicks 5 and counts 4. So every
 * test here reads the value AND the query string it goes to - and for the
 * employee tiles, parses that query string back through the list's own reader,
 * which is what the page will do with it.
 */

const summary: DashboardSummary = {
  employees: {
    total: 568,
    male: 402,
    female: 160,
    other: 1,
    notRecorded: 5,
    archived: 12,
    // Active + left, archived left out - which is what the Total tile shows.
    activeAndLeft: 615,
    joinedLast30Days: 9,
    left: 47,
    leftThisYear: 23,
  },
  documents: {
    total: 5680,
    received: 5623,
    verified: 4100,
    pending: 57,
    overdue: 34,
    dueSoon: 11,
  },
  // Complete + Incomplete = the 568 active employees, always.
  checklists: { complete: 41, incomplete: 527 },
  employeesMissingMandatory: 8,
  signatures: { awaiting: 0, employeesWithoutSignature: 5 },
}

function byKey<T extends { key: string }>(tiles: T[], key: string): T {
  const tile = tiles.find((candidate) => candidate.key === key)
  if (!tile) throw new Error(`no tile called ${key}`)
  return tile
}

/** The filters the employee list will actually apply for a tile's link. */
const filtersFor = (to: string) =>
  readEmployeeFilters(new URLSearchParams(to.split('?')[1] ?? ''))

describe('needs attention', () => {
  it('shows the employees who have never signed, not the documents awaiting one', () => {
    // These were two tiles saying the same thing with different numbers - an
    // 'Awaiting signature' counting documents and a 'No signature on file'
    // counting people. This is the one that can be acted on.
    const tile = byKey(needsAttentionTiles(summary), 'withoutSignature')

    expect(tile.label).toBe('Pending employee signature')
    expect(tile.hint).toBe('Employees who have not signed on the pad yet')
    expect(tile.value).toBe(summary.signatures.employeesWithoutSignature)
    expect(tile.value).not.toBe(summary.signatures.awaiting)
  })

  it('opens each list on the same rows it counted', () => {
    const tiles = needsAttentionTiles(summary)

    expect(byKey(tiles, 'overdue').to).toBe('/documents?state=overdue')
    expect(byKey(tiles, 'dueSoon').to).toBe('/documents?state=dueSoon')
    expect(filtersFor(byKey(tiles, 'missingIdCard').to).missingIdCard).toBe(true)
    expect(filtersFor(byKey(tiles, 'withoutSignature').to).withoutSignature).toBe(true)
  })

  it('sends the document tiles to the documents list, not the employee list', () => {
    // 'Overdue 34' is 34 documents; the employee list would show a different
    // number, every time.
    for (const key of ['overdue', 'dueSoon']) {
      expect(byKey(needsAttentionTiles(summary), key).to.startsWith('/documents')).toBe(true)
    }
  })

  it('reads calm when there is nothing to do', () => {
    const quiet: DashboardSummary = {
      ...summary,
      documents: { ...summary.documents, overdue: 0, dueSoon: 0 },
      employeesMissingMandatory: 0,
      signatures: { awaiting: 0, employeesWithoutSignature: 0 },
    }

    for (const tile of needsAttentionTiles(quiet)) expect(tile.tone).toBe('good')
  })
})

describe('the employee tiles', () => {
  it('leads with Total, then the three it breaks into', () => {
    expect(employeeTiles(summary).map((tile) => tile.label)).toEqual([
      'Total employees',
      'Active',
      'Left this year',
      'Archived',
    ])
  })

  it('shows Total as active plus left, with archived left out', () => {
    const tile = byKey(employeeTiles(summary), 'activeAndLeft')

    // The number HR would quote, and the sum of the two tiles after it.
    expect(tile.value).toBe(summary.employees.total + summary.employees.left)
    expect(tile.value).toBe(summary.employees.activeAndLeft)
    // Not the archived records, which are struck-out entries rather than people.
    expect(tile.value).not.toBe(
      summary.employees.total + summary.employees.left + summary.employees.archived,
    )
    expect(tile.hint).toBe('Active and left, excluding archived')
  })

  it('opens Total on active and left together, and on nothing else', () => {
    const filters = filtersFor(byKey(employeeTiles(summary), 'activeAndLeft').to)

    // 'all' is the two of them; archived stays out because includeArchived is
    // off, which leaves the list holding exactly what the tile counted.
    expect(filters.status).toBe('all')
    expect(filters.includeArchived).toBe(false)
    expect(filters.archivedOnly).toBe(false)
  })

  it('opens Active on those still here', () => {
    const tile = byKey(employeeTiles(summary), 'active')
    const filters = filtersFor(tile.to)

    expect(tile.value).toBe(568)
    expect(filters.status).toBe('active')
    expect(filters.includeArchived).toBe(false)
  })

  it('opens Left this year including archived records, as the tile counts them', () => {
    const tile = byKey(employeeTiles(summary), 'leftThisYear')
    const filters = filtersFor(tile.to)

    expect(tile.value).toBe(23)
    expect(filters.status).toBe('left')
    expect(filters.leftThisYear).toBe(true)
    // Archived records are out of this count, as they are out of every other
    // count on the page, so the list must not ask for them either.
    expect(filters.includeArchived).toBe(false)
  })

  it('opens Archived on the archived records alone', () => {
    const filters = filtersFor(byKey(employeeTiles(summary), 'archived').to)

    expect(filters.archivedOnly).toBe(true)
    // 'all', because an archived record may belong to somebody who has left and
    // the tile counts those too.
    expect(filters.status).toBe('all')
  })
})

describe('the gender split', () => {
  it('keeps every count, including the one nobody recorded', () => {
    const slices = genderSlices(summary)

    expect(slices.map((slice) => slice.value)).toEqual([402, 160, 1, 5])
    expect(slices.map((slice) => slice.label)).toEqual(['Men', 'Women', 'Other', 'Not recorded'])
  })

  it('opens each side on that gender', () => {
    for (const slice of genderSlices(summary)) {
      const filters = filtersFor(slice.to)
      expect(filters.gender).toBe(slice.key)
      // Counted against those still here, exactly as the tile counts them.
      expect(filters.status).toBe('active')
    }
  })
})

describe('the checklist tiles', () => {
  it('is two tiles counting people, not document rows', () => {
    const tiles = documentTiles(summary)

    expect(tiles.map((tile) => tile.label)).toEqual(['Complete', 'Incomplete'])
    // Not the row counts they replaced: 57 outstanding ROWS might be five
    // people or fifty, and the office chases people.
    expect(tiles.map((tile) => tile.value)).toEqual([41, 527])
    expect(tiles.map((tile) => tile.value)).not.toContain(summary.documents.pending)
  })

  it('accounts for every active employee between them', () => {
    const [complete, incomplete] = documentTiles(summary)

    expect((complete?.value ?? 0) + (incomplete?.value ?? 0)).toBe(summary.employees.total)
  })

  it('says how many of how many, on the card', () => {
    expect(byKey(documentTiles(summary), 'complete').hint).toBe('41 of 568 employees')
    expect(byKey(documentTiles(summary), 'incomplete').hint).toBe('527 of 568 employees')
  })

  it('opens the employees in that state, worst first for the incomplete', () => {
    const tiles = documentTiles(summary)

    expect(filtersFor(byKey(tiles, 'complete').to).checklist).toBe('complete')

    const incomplete = filtersFor(byKey(tiles, 'incomplete').to)
    expect(incomplete.checklist).toBe('incomplete')
    // The employee with the most outstanding documents is read first.
    expect(incomplete.sortBy).toBe('documentsPending')
    expect(incomplete.sortDir).toBe('desc')
  })
})

describe('every tile', () => {
  it('goes somewhere', () => {
    const all = [
      ...needsAttentionTiles(summary),
      ...employeeTiles(summary),
      ...documentTiles(summary),
    ]

    expect(all).toHaveLength(10)
    for (const tile of all) expect(tile.to).toMatch(/^\/(employees|documents)/)
    for (const slice of genderSlices(summary)) expect(slice.to).toMatch(/^\/employees/)
  })

  it('asks the API for exactly what its link says', () => {
    // The page turns the URL into a query; this is that path end to end, so a
    // filter that the reader drops would be caught here rather than by somebody
    // counting rows.
    const query = toEmployeeListQuery(
      filtersFor(byKey(needsAttentionTiles(summary), 'withoutSignature').to),
      25,
    )

    expect(query.withoutSignature).toBe(true)
    expect(query.status).toBe('active')
    expect(query.page).toBe(1)
  })
})
