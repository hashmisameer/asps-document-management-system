import {
  MIN_PLACEMENT_SIZE,
  SIGNER_ROLES,
  clampToPage,
  type NormalizedRect,
  type PageRotation,
  type SignerRole,
} from '@asps-dms/shared'

/**
 * The editor's own model of a placement, and the geometry it needs.
 *
 * Kept apart from the React component so the maths can be tested without a PDF,
 * a canvas or a pointer. The conversions themselves are NOT redefined here -
 * they come from shared/src/utils/coordinates.ts, which the stamper also uses.
 * A second copy of that arithmetic is exactly how an editor preview and its
 * output drift apart (see docs/coordinate-system.md, rule 3).
 */

/** A placement being edited. Coordinates are normalized displayed-page space. */
export interface DraftPlacement {
  /** Local to this editing session; never sent. Placements have no id until saved. */
  key: string
  pageNumber: number
  pageRotation: PageRotation
  signerRole: SignerRole
  rect: NormalizedRect
}

/** Where a new box lands: a readable default the person then drags into place. */
const DEFAULT_RECT: NormalizedRect = { x: 0.62, y: 0.78, width: 0.28, height: 0.09 }

/**
 * A photograph's box starts where a form prints one - top right - and roughly
 * passport-shaped. The picture keeps its own proportions inside whatever the
 * box is dragged to, so this only has to be a sensible place to start.
 */
const PHOTO_RECT: NormalizedRect = { x: 0.76, y: 0.06, width: 0.16, height: 0.14 }

/**
 * Nudges each new box clear of the last one on the same page.
 *
 * Two boxes dropped at the same default would sit exactly on top of each other,
 * and the one underneath cannot be grabbed. Offsetting keeps both reachable.
 */
export function nextRect(
  existing: readonly DraftPlacement[],
  pageNumber: number,
  signerRole: SignerRole = SIGNER_ROLES.EMPLOYEE,
): NormalizedRect {
  const onPage = existing.filter((placement) => placement.pageNumber === pageNumber).length
  const step = 0.03 * onPage
  const start = signerRole === SIGNER_ROLES.PHOTO ? PHOTO_RECT : DEFAULT_RECT
  return clampToPage({
    ...start,
    x: start.x - step,
    y: start.y - step,
  })
}

export function newPlacement(
  existing: readonly DraftPlacement[],
  pageNumber: number,
  pageRotation: PageRotation,
  signerRole: SignerRole,
): DraftPlacement {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pageNumber,
    pageRotation,
    signerRole,
    rect: nextRect(existing, pageNumber, signerRole),
  }
}

/**
 * Moves a box by a pixel delta, keeping it on the page.
 *
 * Clamped rather than refused: a drag that would leave the page is a hand
 * moving too far, not a decision, so the box stops at the edge. What must never
 * be clamped is a SAVE - the schema and the CHECK constraint reject an
 * out-of-bounds placement instead of quietly correcting it.
 */
export function moveRect(
  rect: NormalizedRect,
  deltaXPx: number,
  deltaYPx: number,
  rendered: { width: number; height: number },
): NormalizedRect {
  return clampToPage({
    ...rect,
    x: rect.x + deltaXPx / rendered.width,
    y: rect.y + deltaYPx / rendered.height,
  })
}

/**
 * Resizes from the bottom-right corner, keeping the top-left anchored.
 *
 * The box is held to at least MIN_PLACEMENT_SIZE - the same floor the schema
 * enforces - so the editor cannot produce a placement the server would reject,
 * and a box can never be shrunk to nothing and lost.
 */
export function resizeRect(
  rect: NormalizedRect,
  deltaXPx: number,
  deltaYPx: number,
  rendered: { width: number; height: number },
): NormalizedRect {
  const width = Math.min(
    Math.max(rect.width + deltaXPx / rendered.width, MIN_PLACEMENT_SIZE),
    1 - rect.x,
  )
  const height = Math.min(
    Math.max(rect.height + deltaYPx / rendered.height, MIN_PLACEMENT_SIZE),
    1 - rect.y,
  )
  return { ...rect, width, height }
}
