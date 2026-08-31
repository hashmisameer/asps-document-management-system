#!/usr/bin/env node
/**
 * Build-blocking secret and personal-data check.
 *
 * This repository will eventually be handled alongside real employee records,
 * PAN and Aadhaar scans, and the company's database credentials. None of that
 * may ever reach a commit, and .gitignore only helps for paths someone thought
 * of in advance. This scans everything that would be committed: what git
 * tracks, plus untracked files .gitignore does not already exclude.
 *
 * Three things fail the build:
 *   1. A file that should never be committed at all (.env, a private key,
 *      a database backup, a document scan).
 *   2. A credential-shaped value inside a file.
 *   3. An Indian PAN or Aadhaar number - the two identifiers most likely to be
 *      pasted into a fixture or a test.
 *
 * Run: npm run check:secrets
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [
  { pattern: /(^|\/)\.env$/i, why: 'environment file with real credentials' },
  { pattern: /(^|\/)\.env\.(?!example$)[\w.-]+$/i, why: 'environment file with real credentials' },
  { pattern: /\.(pem|key|pfx|p12|jks|keystore)$/i, why: 'private key or certificate store' },
  { pattern: /\.(bak|mdf|ldf|trn)$/i, why: 'database backup or data file' },
  { pattern: /\.(pdf|jpe?g|png|tiff?|bmp|heic)$/i, why: 'possible document scan or signature image' },
]

/**
 * A file matching FORBIDDEN_PATHS is allowed only if it is listed here. Each
 * entry is an exact repo-relative path, so adding one is a deliberate act.
 */
const PATH_ALLOWLIST = new Set([])

/** Directories that are checked out but not ours to police. */
const SKIP_DIRS = ['node_modules/', 'dist/', 'build/', 'coverage/', 'package-lock.json']

/** Text extensions worth scanning for secret-shaped content. */
const SCANNED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.sql', '.md', '.yml', '.yaml', '.env.example', '.txt', '.html', '.css',
]

const SECRET_PATTERNS = [
  {
    // A password or secret assigned a non-empty literal. Placeholders such as
    // an empty value, <fill-me> or ${VAR} are what belongs in an example file.
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*['"`]([^'"`\n]{6,})['"`]/i,
    describe: 'hard-coded credential',
    allow: (value) =>
      /^(\$\{|<|\{\{|change[_-]?me|your[_-]|placeholder|example|xxx+|\*+|test|dummy|fake|redacted)/i.test(
        value,
      ),
  },
  {
    pattern: /\b(?:Server|Data Source)\s*=\s*[^;'"\n]+;[^'"\n]*\bPassword\s*=\s*[^;'"\n]+/i,
    describe: 'SQL Server connection string with a password',
    allow: () => false,
  },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    describe: 'private key block',
    allow: () => false,
  },
  {
    // PAN: five letters, four digits, one letter. Section 89 of the spec makes
    // PAN Card the one confirmed mandatory document, so a real number is very
    // plausible in a fixture - and must not be committed.
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,
    describe: 'value shaped like a PAN number',
    allow: () => false,
  },
  {
    // Aadhaar: 12 digits, conventionally written in groups of four.
    pattern: /\b[2-9][0-9]{3}[ -][0-9]{4}[ -][0-9]{4}\b/,
    describe: 'value shaped like an Aadhaar number',
    allow: () => false,
  },
]

/**
 * Marks a finding as reviewed and deliberate: `// asps-dms:allow-secret`, on
 * the flagged line or the line above it, so the reason can be written out in
 * full above a long line instead of being crammed onto the end of it.
 */
const INLINE_ALLOW = /asps-dms:allow-secret/

/**
 * Everything that would end up in a commit: files git already tracks, plus
 * untracked files that .gitignore does not exclude. Scanning the second group
 * is the point - it catches a stray .env or a scan before `git add`, not after.
 */
function committableFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return output.split('\0').filter(Boolean)
}

const problems = []

function checkPaths(files) {
  for (const file of files) {
    if (PATH_ALLOWLIST.has(file)) continue
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.pattern.test(file)) {
        problems.push(
          `${file}  would be committed, but looks like a ${rule.why}. ` +
            `Untrack it with 'git rm --cached', confirm .gitignore covers it, ` +
            `and rotate anything it exposed.`,
        )
        break
      }
    }
  }
}

async function checkContents(files) {
  const scannable = files.filter(
    (file) =>
      !SKIP_DIRS.some((skip) => file.startsWith(skip) || file === skip) &&
      SCANNED_EXTENSIONS.some((ext) => file.endsWith(ext)),
  )

  for (const file of scannable) {
    let text
    try {
      text = await fs.readFile(path.join(repoRoot, file), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') continue // deleted but still in the index
      throw err
    }

    // This script necessarily contains the patterns it looks for.
    if (file === 'scripts/check-secrets.mjs') continue

    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (INLINE_ALLOW.test(line) || INLINE_ALLOW.test(lines[index - 1] ?? '')) return
      for (const rule of SECRET_PATTERNS) {
        const match = rule.pattern.exec(line)
        if (match && !rule.allow(match[1] ?? '')) {
          // The finding names the file and the rule, never the value.
          problems.push(`${file}:${index + 1}  ${rule.describe}.`)
          break
        }
      }
    })
  }

  return scannable.length
}

const files = committableFiles()
checkPaths(files)
const scannedCount = await checkContents(files)

if (problems.length > 0) {
  console.error('Secret check FAILED:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s) found. If a finding is deliberate and harmless, ` +
      `add 'asps-dms:allow-secret' to that line, or the path to PATH_ALLOWLIST in ` +
      `scripts/check-secrets.mjs, with a comment saying why.`,
  )
  process.exit(1)
}

console.log(`Secret check passed (${files.length} committable file(s), ${scannedCount} scanned).`)
