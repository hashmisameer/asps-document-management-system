import { SIGNER_ROLE_LABEL, type BoxOccupancy } from '@asps-dms/shared'

/**
 * The words on the warning that a box already has something in it.
 *
 * Kept apart from the editor so the sentences can be tested without a PDF on
 * screen. The numbers are the server's own measurements, shown so the person
 * deciding to stamp anyway is deciding on evidence rather than on a hunch.
 */

export interface OccupancyLine {
  /** 'Employee signature box on page 2' */
  where: string
  /** 'Already has something in it' or 'Could not tell' */
  verdict: string
  /** The evidence, in plain words. */
  because: string
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

function evidence(box: BoxOccupancy): string {
  if (box.decidedBy === 'image') {
    return box.overlap.images === 1
      ? `an image covers ${percent(box.overlap.coverage)} of it`
      : `${box.overlap.images} images are on it, one covering ${percent(box.overlap.coverage)}`
  }
  if (box.decidedBy === 'ink' && box.ink) {
    return `${box.ink.percent.toFixed(1)}% of it is ink, measured against the page's own background`
  }
  return box.reason
}

export function describeOccupancy(box: BoxOccupancy): OccupancyLine {
  return {
    where: `${SIGNER_ROLE_LABEL[box.signerRole]} box on page ${box.pageNumber}`,
    verdict: box.verdict === 'occupied' ? 'Already has something in it' : 'Could not tell',
    because: evidence(box),
  }
}

/** The one-line title over the list. */
export function occupancyTitle(boxes: readonly BoxOccupancy[]): string {
  const occupied = boxes.filter((box) => box.verdict === 'occupied').length
  const uncertain = boxes.length - occupied
  if (occupied > 0 && uncertain === 0) {
    return occupied === 1
      ? 'That box already has something in it'
      : `${occupied} of the boxes already have something in them`
  }
  if (occupied === 0) {
    return uncertain === 1
      ? 'It is not clear whether that box is empty'
      : `It is not clear whether ${uncertain} of the boxes are empty`
  }
  return `${occupied} of the boxes already have something in them, and ${uncertain} may`
}

/** Only the boxes worth a warning: an empty one needs no sentence. */
export function notEmpty(boxes: readonly BoxOccupancy[]): BoxOccupancy[] {
  return boxes.filter((box) => box.verdict !== 'empty')
}
