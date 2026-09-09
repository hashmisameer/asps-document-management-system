/**
 * Taking identity numbers out of text before it is written to a log.
 *
 * WHY THIS EXISTS AT ALL. Diagnosing why a document did not read means seeing
 * what the OCR made of it. But the text of a PAN card contains the PAN number
 * and the text of an Aadhaar card contains the Aadhaar number, and the server's
 * log files are never rotated or deleted - so logging that text once per upload
 * builds, over 550 employees, a plain-text file of everybody's identity numbers
 * sitting beside the application. The whole system is self-hosted precisely so
 * that this data does not leave the building; a log file is inside the building
 * and is still the wrong place for it.
 *
 * Truncating alone does NOT solve it. A PAN card prints its number near the
 * top, so the first 200 characters are exactly where it is. Masking has to come
 * first, and truncation after it.
 *
 * MASKING HAPPENS HERE, NOT IN THE LOGGER. A logger that redacts is a logger
 * somebody bypasses - one `logger.info({ text })` anywhere and the raw text is
 * on disk. Callers pass text through logSafeText and there is no path that logs
 * the text without it.
 *
 * What is left is enough to answer the two questions worth asking: did OCR read
 * anything at all, and was the name in what it read.
 */

/**
 * A PAN number: five letters, four digits, a letter.
 *
 * Case-insensitive because OCR does not reliably return capitals, and spaces
 * are allowed between the groups because it inserts them where a card has none.
 */
const PAN_PATTERN = /\b[A-Z]{5}\s?[0-9]{4}\s?[A-Z]\b/gi

/**
 * An Aadhaar number: twelve digits, printed in groups of four.
 *
 * Both spellings are masked - the grouped form the card prints and the plain
 * twelve digits OCR sometimes returns when it misses the gaps.
 */
const AADHAAR_PATTERN = /\b[0-9]{4}\s?[0-9]{4}\s?[0-9]{4}\b/g

/** How much of a document's text is worth keeping to diagnose a failed read. */
export const LOG_TEXT_LIMIT = 200

/** The same text with anything shaped like an identity number replaced. */
export function maskIdentityNumbers(text: string): string {
  return text.replace(PAN_PATTERN, 'PAN-XXXXX').replace(AADHAAR_PATTERN, 'AADHAAR-XXXX')
}

/**
 * What may be written to a log: masked first, then cut short.
 *
 * In that order, and the order is the point. Cutting first would keep the first
 * 200 characters of a PAN card, which is where the PAN number is.
 */
export function logSafeText(text: string, limit: number = LOG_TEXT_LIMIT): string {
  const masked = maskIdentityNumbers(text)
  return masked.length <= limit ? masked : `${masked.slice(0, limit)}...`
}
