import { describe, expect, it } from 'vitest'
import {
  SIGNER_ROLES,
  canAddBox,
  limitFor,
  overLimit,
  placementLimits,
  type SignerRole,
} from '@asps-dms/shared'

/**
 * How many boxes of a role a page may hold.
 *
 * The guard against a second signature on a page that already has one. The
 * limit is the template's own count, at least one, never below what the
 * document already holds - and nothing in it names a document type.
 */

const box = (pageNumber: number, signerRole: SignerRole) => ({ pageNumber, signerRole })
const row = (pageCount: number, pageNumber: number, signerRole: SignerRole, widthPt = 595) => ({
  variant: { pageCount, widthPt, heightPt: 842 },
  pageNumber,
  signerRole,
})

/** The ESIC form's page: a photograph, two HR boxes and the employee's. */
const esic = [
  row(1, 1, SIGNER_ROLES.PHOTO),
  row(1, 1, SIGNER_ROLES.AUTHORISER),
  row(1, 1, SIGNER_ROLES.AUTHORISER),
  row(1, 1, SIGNER_ROLES.EMPLOYEE),
]

describe('placementLimits', () => {
  it('takes the template’s own count for each page and role', () => {
    const limits = placementLimits(esic, 1, [])

    expect(limitFor(limits, 1, SIGNER_ROLES.AUTHORISER)).toBe(2)
    expect(limitFor(limits, 1, SIGNER_ROLES.EMPLOYEE)).toBe(1)
    expect(limitFor(limits, 1, SIGNER_ROLES.PHOTO)).toBe(1)
  })

  it('allows one of each role where the template says nothing, or there is no template', () => {
    expect(limitFor(placementLimits([], 1, []), 1, SIGNER_ROLES.EMPLOYEE)).toBe(1)
    expect(limitFor(placementLimits(esic, 1, []), 2, SIGNER_ROLES.AUTHORISER)).toBe(1)
  })

  it('never falls below what the document already holds', () => {
    // Placed by hand before the rule: two employee boxes on page 1.
    const limits = placementLimits(esic, 1, [box(1, 'Employee'), box(1, 'Employee')])
    expect(limitFor(limits, 1, SIGNER_ROLES.EMPLOYEE)).toBe(2)
  })

  it('counts only the variants with the document’s page count, each on its own', () => {
    // PF: Form 11 (1 page) and Form 2 (2 pages), an employee box per page.
    const pf = [
      row(1, 1, SIGNER_ROLES.EMPLOYEE),
      row(1, 1, SIGNER_ROLES.AUTHORISER),
      row(2, 1, SIGNER_ROLES.EMPLOYEE),
      row(2, 2, SIGNER_ROLES.EMPLOYEE),
      row(2, 2, SIGNER_ROLES.AUTHORISER),
    ]
    const twoPage = placementLimits(pf, 2, [])
    expect(limitFor(twoPage, 1, SIGNER_ROLES.EMPLOYEE)).toBe(1)
    expect(limitFor(twoPage, 2, SIGNER_ROLES.EMPLOYEE)).toBe(1)
    // Counted per variant, never added up across them.
    expect(limitFor(placementLimits(pf, null, []), 1, SIGNER_ROLES.EMPLOYEE)).toBe(1)
  })

  it('takes the highest where variants share a page count - never their sum', () => {
    // Two one-page forms of different sizes: one with two HR boxes, one with
    // one. Which the document is cannot be known without reading it, so the
    // limit is the larger - erring towards allowing - and never the three
    // that adding them up would give.
    const twoShapes = [
      row(1, 1, SIGNER_ROLES.AUTHORISER, 595),
      row(1, 1, SIGNER_ROLES.AUTHORISER, 595),
      row(1, 1, SIGNER_ROLES.AUTHORISER, 612),
    ]
    expect(limitFor(placementLimits(twoShapes, 1, []), 1, SIGNER_ROLES.AUTHORISER)).toBe(2)
  })
})

describe('overLimit and canAddBox', () => {
  const limits = placementLimits(esic, 1, [])

  it('lets a stamped ESIC page be saved exactly as it is', () => {
    const stamped = [box(1, 'Photo'), box(1, 'Authoriser'), box(1, 'Authoriser'), box(1, 'Employee')]
    expect(overLimit(stamped, limits)).toEqual([])
  })

  it('refuses a second employee signature, and a third HR box, on that page', () => {
    const doubled = [
      box(1, 'Employee'),
      box(1, 'Employee'),
      box(1, 'Authoriser'),
      box(1, 'Authoriser'),
      box(1, 'Authoriser'),
    ]
    expect(overLimit(doubled, limits)).toEqual([
      { pageNumber: 1, signerRole: 'Authoriser', count: 3, max: 2 },
      { pageNumber: 1, signerRole: 'Employee', count: 2, max: 1 },
    ])
  })

  it('counts each page apart', () => {
    expect(overLimit([box(1, 'Employee'), box(2, 'Employee')], limits)).toEqual([])
  })

  it('says whether one more box may go on the page', () => {
    expect(canAddBox([], limits, 1, SIGNER_ROLES.EMPLOYEE)).toBe(true)
    expect(canAddBox([box(1, 'Employee')], limits, 1, SIGNER_ROLES.EMPLOYEE)).toBe(false)
    expect(canAddBox([box(1, 'Authoriser')], limits, 1, SIGNER_ROLES.AUTHORISER)).toBe(true)
    expect(canAddBox([box(1, 'Employee')], limits, 2, SIGNER_ROLES.EMPLOYEE)).toBe(true)
  })
})
