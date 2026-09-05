/**
 * Escapes the wildcards LIKE would otherwise read as syntax.
 *
 * Without this, a search for '100%' matches every row and a stray '[' opens a
 * character class that swallows the rest of the term. Only the three pattern
 * characters and the escape character itself are escaped: ']' outside a class
 * is already a literal, and escaping characters that are not special is not
 * something to rely on. The escape character is declared with ESCAPE in the
 * clause itself.
 *
 * Here rather than beside one query because every list that offers a search box
 * needs it, and a second copy is a copy that gets fixed once.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (character) => `\\${character}`)
}
