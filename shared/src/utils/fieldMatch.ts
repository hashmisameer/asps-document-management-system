import {
  DOCUMENT_FIELD_MATCH,
  type DocumentField,
} from '../constants/documentFields.js'

/**
 * Comparing what a document says with what the employee record says.
 *
 * Pure functions with no idea where the text came from - a PDF's own text layer
 * or an OCR pass over a scan - so the same rules are testable directly and mean
 * the same thing wherever they run.
 *
 * The comparisons are deliberately LITERAL. Nothing here scores a similarity or
 * guesses at a near miss: this check refuses uploads, and a rule that decides
 * 'NAMDEV' is close enough to 'NAMDEO' is a rule that files a document against
 * the wrong person. Where a real document legitimately fails - a scan too poor
 * for OCR to read a digit correctly - the answer is the recorded, audited
 * override, not a matcher that quietly accepts approximations.
 */

/** Upper case, and every run of anything but a letter or digit becomes a space. */
export function normalizeText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

export function words(text: string): string[] {
  const normalized = normalizeText(text)
  return normalized.length === 0 ? [] : normalized.split(' ')
}

/**
 * Every significant word of the expected value appears in the document.
 *
 * Word by word rather than as one string, because a document writes a name in
 * whatever order and with whatever punctuation its form uses - 'HASHMI, SAMEER'
 * and 'Sameer Hashmi' are the same person. Single letters are skipped: an
 * initial matches almost anything and would wave through a name that is not
 * there at all.
 */
export function matchWords(expected: string, documentText: string): boolean {
  const wanted = words(expected).filter((word) => word.length > 1)
  if (wanted.length === 0) return false

  const present = new Set(words(documentText))
  return wanted.every((word) => present.has(word))
}

/**
 * The employee code, allowing for it being printed with a space in it.
 *
 * 'EMP007' and 'EMP 007' are the same code on a form. Adjacent words are joined
 * pairwise to catch the second, rather than stripping every space in the
 * document, which would let a code appear by accident across the end of one
 * word and the start of the next.
 */
export function matchCode(expected: string, documentText: string): boolean {
  const wanted = normalizeText(expected).replace(/ /g, '')
  if (wanted.length === 0) return false

  const found = words(documentText)
  for (let i = 0; i < found.length; i += 1) {
    const word = found[i]
    if (word === wanted) return true

    const next = found[i + 1]
    if (next !== undefined && word !== undefined && word + next === wanted) return true
  }
  return false
}

/**
 * Runs of digits, with the separators inside a number removed.
 *
 * An Aadhaar number is printed '1234 5678 9012' and a phone number
 * '+91 98765-43210'; both are one number, and a split on non-digits would make
 * them three and two. Only separators BETWEEN two digits are dropped, so
 * '10/04/2024' stays three numbers rather than becoming one eight-digit run
 * that could match anything.
 */
export function digitRuns(text: string): string[] {
  const joined = text.replace(/(?<=\d)[\s\-‑–]+(?=\d)/g, '')
  return joined.match(/\d+/g) ?? []
}

/**
 * A number the document contains.
 *
 * `contains` rather than `equals`, because the surrounding text is not under
 * anyone's control: a phone number may be printed with a country code in front
 * of it, and an ESI number inside a longer reference.
 */
export function matchDigits(expected: string, documentText: string): boolean {
  const wanted = expected.replace(/\D/g, '')
  // Four digits or fewer would match by coincidence on almost any form.
  if (wanted.length < 5) return false

  return digitRuns(documentText).some((run) => run.includes(wanted))
}

const PAN_PATTERN = /[A-Z]{5}[0-9]{4}[A-Z]/g

/** A PAN, compared exactly. Its shape is fixed, so there is nothing to be lenient about. */
export function matchPan(expected: string, documentText: string): boolean {
  const wanted = expected.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(wanted)) return false

  const candidates: string[] =
    documentText
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .match(PAN_PATTERN) ?? []
  return candidates.includes(wanted)
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Two digits written for a year.
 *
 * '24' is 2024 and '98' is 1998. The pivot is 50, which covers every joining
 * date and date of birth this system will ever see by a wide margin.
 */
function fullYear(value: number): number {
  if (value >= 100) return value
  return value < 50 ? 2000 + value : 1900 + value
}

/**
 * Every calendar date the text could be read as, as 'YYYY-MM-DD'.
 *
 * A numeric date with both parts under 13 is genuinely ambiguous - 04/03/2024
 * is written for both the 4th of March and the 3rd of April - so BOTH readings
 * are returned. That is the lenient direction on purpose: this set decides
 * whether a document is refused, and refusing a real appointment letter because
 * the form was printed in American order is a worse failure than accepting one
 * whose date could be read two ways.
 */
/**
 * The same text with the gaps a scanner leaves inside a date closed up.
 *
 * A printed form puts each character of a date in its own box, and OCR reads
 * those boxes as separate tokens: '01 - 04 - 2026', or '0 1 / 0 4 / 2 0 2 6'.
 * Both are the date a person reads at a glance, and neither matched - which
 * made the identity check refuse service cards that were perfectly correct.
 *
 * Only whitespace touching a digit or a date separator is closed, so two words
 * are never joined and nothing outside a number is affected.
 */
function closeDateGaps(text: string): string {
  return text
    .replace(/(?<=\d)[ \t]+(?=[\d/\-.])/g, '')
    .replace(/(?<=[/\-.])[ \t]+(?=\d)/g, '')
}

export function extractDates(text: string): Set<string> {
  const found = new Set<string>()
  const original = text.toUpperCase()
  const closed = closeDateGaps(original)

  // Both readings are searched. The closed-up one finds a date OCR spaced out;
  // the original is still read because closing gaps can run two separate
  // numbers together, and a date invented that way would pass a document that
  // should have been refused.
  for (const upper of closed === original ? [original] : [original, closed]) {
  // 2024-04-01, 2024/04/01
  for (const match of upper.matchAll(/\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/g)) {
    const [, y, m, d] = match
    const year = Number(y)
    const month = Number(m)
    const day = Number(d)
    if (isRealDate(year, month, day)) found.add(iso(year, month, day))
  }

  // 01/04/2024, 1-4-24, 01.04.2024 - in either order
  for (const match of upper.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g)) {
    const [, a, b, y] = match
    const first = Number(a)
    const second = Number(b)
    const year = fullYear(Number(y))
    if (isRealDate(year, second, first)) found.add(iso(year, second, first))
    if (isRealDate(year, first, second)) found.add(iso(year, first, second))
  }

  // 1 April 2024, 01ST APR, 2024
  for (const match of upper.matchAll(
    /\b(\d{1,2})\s*(?:ST|ND|RD|TH)?[\s,.-]*([A-Z]{3,9})[\s,.-]+(\d{2,4})\b/g,
  )) {
    const [, d, name, y] = match
    const month = MONTHS[(name ?? '').slice(0, 3)]
    const day = Number(d)
    const year = fullYear(Number(y))
    if (month !== undefined && isRealDate(year, month, day)) found.add(iso(year, month, day))
  }

  // April 1, 2024
  for (const match of upper.matchAll(
    /\b([A-Z]{3,9})[\s,.-]+(\d{1,2})\s*(?:ST|ND|RD|TH)?[\s,.-]+(\d{2,4})\b/g,
  )) {
    const [, name, d, y] = match
    const month = MONTHS[(name ?? '').slice(0, 3)]
    const day = Number(d)
    const year = fullYear(Number(y))
    if (month !== undefined && isRealDate(year, month, day)) found.add(iso(year, month, day))
  }

  }

  return found
}

/** The document names this calendar day, however it chose to write it. */
export function matchDate(expectedIso: string, documentText: string): boolean {
  const wanted = expectedIso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted)) return false
  return extractDates(documentText).has(wanted)
}

/**
 * Runs the comparison the field calls for.
 *
 * One entry point, so the service that refuses an upload never chooses a
 * comparison itself and the mapping from field to rule stays in one table.
 */
export function matchField(
  field: DocumentField,
  expected: string,
  documentText: string,
): boolean {
  switch (DOCUMENT_FIELD_MATCH[field]) {
    case 'name':
    case 'text':
      return matchWords(expected, documentText)
    case 'code':
      return matchCode(expected, documentText)
    case 'date':
      return matchDate(expected, documentText)
    case 'digits':
      return matchDigits(expected, documentText)
    case 'pan':
      return matchPan(expected, documentText)
  }
}
