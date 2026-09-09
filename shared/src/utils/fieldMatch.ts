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
 * The comparisons used to be entirely LITERAL, on the reasoning that a matcher
 * deciding 'NAMDEV' is close enough to 'NAMDEO' is a matcher that files a
 * document against the wrong person. That reasoning held while a failed check
 * REFUSED the upload. It no longer does: every document is stored whatever the
 * reading says, and the check's job is now to tell somebody whether to look.
 *
 * So the NAME is compared with a tolerance, and nothing else is. Every identity
 * card at this company is a low-contrast photocopy where a character or two
 * comes back wrong, and a name is long enough to survive that and still be
 * unmistakable. The tolerance is by word length - see allowedSlips, which is
 * where the safety of this actually lives. Numbers and dates stay literal: a
 * digit that is wrong is simply a different number.
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
 * How many single-character edits turn one word into the other.
 *
 * The ordinary edit distance, written out because this package has no
 * dependencies and one small loop is cheaper than acquiring one. It stops
 * counting once the limit is passed, so a comparison against a completely
 * different word gives up early rather than filling a table.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    let best = i

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (row[j - 1] ?? 0) + 1
      const cost = Math.min(substitution, deletion, insertion)
      row.push(cost)
      if (cost < best) best = cost
    }

    // Nothing later in the table can be lower than the best on this row, so a
    // row that is already past the limit settles it.
    if (best > limit) return limit + 1
    previous = row
  }

  return previous[b.length] ?? limit + 1
}

/**
 * How many characters a word of this length may be wrong by.
 *
 * THE WHOLE SAFETY OF FUZZY MATCHING IS IN THIS TABLE. The check exists to
 * catch one employee's document filed against another's record, and RAM and RAJ
 * are one character apart - allowing a slip on a three-letter name would wave
 * exactly that mistake through. A long word carries enough of itself to survive
 * two wrong characters and still be unmistakable; a short one does not.
 */
export function allowedSlips(length: number): number {
  if (length >= 8) return 2
  if (length >= 5) return 1
  return 0
}

/** The same word, allowing for the characters OCR gets wrong at this length. */
export function fuzzyEquals(expected: string, candidate: string): boolean {
  if (expected === candidate) return true

  const limit = allowedSlips(expected.length)
  if (limit === 0) return false

  return editDistance(expected, candidate, limit) <= limit
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
  if (wanted.every((word) => present.has(word))) return true

  // The same, allowing for the characters OCR gets wrong.
  //
  // Every one of this company's identity cards is a low-contrast photocopy, and
  // a name coming back one character out is the ordinary case: the office's own
  // PAN card reads 'HHAGWAN SINGH' under every setting tried. Refusing to see
  // the employee in that is how a real document ends up needing a human every
  // single time.
  //
  // The tolerance is by word LENGTH, which is what keeps it safe - see
  // fuzzyEquals.
  const onPage = words(documentText)
  if (wanted.every((word) => onPage.some((candidate) => fuzzyEquals(word, candidate)))) return true

  // The document may have run the name together.
  //
  // OCR drops the space between two words often enough that this is the common
  // failure, not a rare one: the office's gratuity form came back reading
  // 'BHAGWANSINGH', every letter correct, and was refused for not mentioning
  // the employee - whose name was printed across the middle of it. The same
  // thing happens the other way round on a form that spaces its capitals out.
  //
  // So the words are also compared with the gaps closed, over a run of ADJACENT
  // document words. Adjacent, rather than anywhere on the page, because
  // 'BHAGWAN' in one corner and 'SINGH' in another is not this employee's name
  // appearing - it is two words that happen to be present, which is how a
  // lenient matcher files a document against the wrong person.
  const target = wanted.join('')
  const found = words(documentText)

  // The run is bounded by the length of the name rather than by a number of
  // words, so this works in both directions: one document word standing for two
  // of the name's, or several standing for one.
  for (let start = 0; start < found.length; start += 1) {
    let run = ''
    for (let end = start; end < found.length; end += 1) {
      run += found[end] ?? ''
      if (run.length > target.length) break
      if (run === target) return true
    }
  }

  return false
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

  // A number printed with leading zeros is the same number. Service cards carry
  // '00006016' where the office says '6016', and refusing that would send
  // someone to override a card that is entirely correct. Applied only when BOTH
  // sides are all digits: 'EMP007' and 'EMP7' are different codes.
  const numeric = (value: string): string =>
    /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value
  const wantedNumeric = numeric(wanted)

  const found = words(documentText)
  for (let i = 0; i < found.length; i += 1) {
    const word = found[i]
    if (word === wanted) return true
    if (word !== undefined && numeric(word) === wantedNumeric) return true

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

  // 01/04/2024, 1-4-24, 01.04.2024 - read DAY first.
  //
  // The company's forms are DD/MM/YYYY, so 01/08/2026 is the 1st of August.
  // Both readings used to be added, which quietly turned the check into a hole:
  // a service card printed 01/08 also matched an employee who joined on the 8th
  // of January, which is exactly the mistake this exists to catch.
  //
  // MM/DD is tried only when DD/MM is not a real date at all - 04/25/2024 has
  // no 25th month, so it can only be American. A document genuinely in that
  // format still matches, rather than failing for a reason nobody could see.
  for (const match of upper.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g)) {
    const [, a, b, y] = match
    const first = Number(a)
    const second = Number(b)
    const year = fullYear(Number(y))
    if (isRealDate(year, second, first)) {
      found.add(iso(year, second, first))
    } else if (isRealDate(year, first, second)) {
      found.add(iso(year, first, second))
    }
  }

  // 01082026 - a date written into a form's boxes, one digit per box, so it
  // reaches OCR with no separators at all. The company's bio data form is laid
  // out exactly this way and the joining date was being missed on every one of
  // them, the check reporting a date absent from a page that plainly carried it.
  //
  // Read DD-MM-YYYY first, to stay with the rest of this file; YYYY-MM-DD only
  // when the leading pair cannot be a day. An eight-digit run that is neither is
  // some other number - an account or a phone - and is left alone.
  for (const match of upper.matchAll(/\b(\d{8})\b/g)) {
    const digits = match[1] ?? ''
    const asDayFirst = {
      day: Number(digits.slice(0, 2)),
      month: Number(digits.slice(2, 4)),
      year: Number(digits.slice(4, 8)),
    }
    const asYearFirst = {
      year: Number(digits.slice(0, 4)),
      month: Number(digits.slice(4, 6)),
      day: Number(digits.slice(6, 8)),
    }
    // With no separators to mark it out, a run of eight digits is only a date
    // if its year is one a person could have lived or worked in. Nothing else
    // distinguishes 31129999 from a date, and the four-digit forms above have
    // punctuation vouching for them where this has none.
    const plausible = (year: number) => year >= 1900 && year <= 2100
    if (plausible(asDayFirst.year) && isRealDate(asDayFirst.year, asDayFirst.month, asDayFirst.day)) {
      found.add(iso(asDayFirst.year, asDayFirst.month, asDayFirst.day))
    } else if (
      plausible(asYearFirst.year) &&
      isRealDate(asYearFirst.year, asYearFirst.month, asYearFirst.day)
    ) {
      found.add(iso(asYearFirst.year, asYearFirst.month, asYearFirst.day))
    }
  }

  // 1 April 2024, 01ST APR, 2024, 01-AUG-2026, 01/AUG/2026
  //
  // A slash counts as a separator here as well as a space or a hyphen. Every
  // document writes its dates its own way and this one is common on Indian
  // forms; without it '01/AUG/2026' was read as no date at all.
  for (const match of upper.matchAll(
    /\b(\d{1,2})\s*(?:ST|ND|RD|TH)?[\s,./-]*([A-Z]{3,9})[\s,./-]+(\d{2,4})\b/g,
  )) {
    const [, d, name, y] = match
    const month = MONTHS[(name ?? '').slice(0, 3)]
    const day = Number(d)
    const year = fullYear(Number(y))
    if (month !== undefined && isRealDate(year, month, day)) found.add(iso(year, month, day))
  }

  // April 1, 2024
  for (const match of upper.matchAll(
    /\b([A-Z]{3,9})[\s,./-]+(\d{1,2})\s*(?:ST|ND|RD|TH)?[\s,./-]+(\d{2,4})\b/g,
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

/**
 * Whether a document reads as the TYPE it is being filed as.
 *
 * The field checks answer "is this about the right person". They cannot answer
 * "is this the right document", because an employee's name and code appear on
 * every document they own - so an Aadhaar card filed against the PAN Card row
 * passes every field check there is.
 *
 * One keyword is enough. Several are configured per type precisely because OCR
 * loses characters: a real service card came back as 'SERVICE CAR', which fails
 * on that phrase and matches 'FORM V' from the same page.
 *
 * Punctuation and spacing are flattened on both sides before comparing, so
 * 'FORM - V', 'FORM-V' and 'FORM  V' are one phrase, and a keyword cannot fail
 * over a hyphen a scanner did or did not see.
 */
export function matchesDocumentType(
  documentText: string,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return true

  const flatten = (value: string): string =>
    value
      .toUpperCase()
      // An apostrophe joins a word rather than breaking it. "EMPLOYEE'S STATE
      // INSURANCE" has to match the keyword "EMPLOYEES STATE INSURANCE", and it
      // would not if the apostrophe became a space.
      .replace(/['’ʼ]/g, '')
      // Everything else that is not a letter or a digit is a break. \p{L} rather
      // than A-Z, so Devanagari survives: a Hindi appointment letter is matched
      // on its own words rather than being transliterated first.
      //
      // Combining marks fall outside \p{L}, so a Devanagari word breaks into its
      // consonants - 'नियुक्ति' becomes 'न य क त'. That is fine, and deliberate:
      // both the document and the keyword are flattened the same way, and it
      // makes the comparison tolerant of the matras OCR most often drops.
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()

  const haystack = flatten(documentText)
  if (haystack.length === 0) return false

  return keywords.some((keyword) => {
    const needle = flatten(keyword)
    return needle.length > 0 && haystack.includes(needle)
  })
}

/**
 * The name a document appears to carry, for showing back to a person.
 *
 * Best effort, and used ONLY in a message - never to decide anything. Deciding
 * is `matchWords`, which asks whether a known name is present; this asks the
 * harder and less answerable question of what name is there, off a page that
 * OCR has already mangled.
 *
 * It looks for a 'Name' label, because the documents this is used on - an
 * Aadhaar card, a PAN card - print one, and takes the words after it. Anything
 * it is unsure of comes back null, and the message then simply says the name
 * was not found rather than inventing one to accuse somebody of.
 */
export function nameOnDocument(documentText: string): string | null {
  const lines = documentText.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    // 'Name', but not 'Father's Name' or 'Mother's Name' - those are somebody
    // else's, and offering one as the document's name would be worse than
    // offering nothing.
    const match = /(?:^|\s)(?<!FATHER'?S? )(?<!MOTHER'?S? )(?<!HUSBAND'?S? )NAME\s*[:-]?\s*(.*)$/i.exec(
      line,
    )
    if (!match) continue

    // The name is often on the line BELOW the label rather than after it -
    // 'नाम / Name' on one line, 'BHAGWAN SINGH' on the next - which is how both
    // of these cards are actually laid out.
    for (const source of [match[1] ?? '', lines[index + 1] ?? '']) {
      const candidate = normalizeText(source)
        .split(' ')
        .filter((word) => word.length > 1 && /^[A-Z]+$/.test(word))
        .join(' ')

      // Two words or more, or it is a label fragment rather than a name.
      if (candidate.split(' ').filter(Boolean).length >= 2) return candidate
    }
  }

  return null
}
