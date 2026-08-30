#!/usr/bin/env node
/**
 * Two build-blocking safety checks.
 *
 * 1. SQL Server 2014 compatibility.
 *    Production runs SQL Server 2014 (major version 12). A newer construct
 *    typically works fine on a developer's newer local instance and then fails
 *    on deployment day. This catches those at commit time instead.
 *
 * 2. SQL injection surface.
 *    Flags interpolated values inside query text. Every query in this codebase
 *    must be parameterised via request.input(...).
 *
 * Run: npm run check:sql-safety
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** T-SQL that requires a SQL Server newer than 2014. */
const FORBIDDEN_TSQL = [
  { pattern: /\bSTRING_AGG\s*\(/i, feature: 'STRING_AGG', since: '2017', instead: 'FOR XML PATH, or aggregate in Node' },
  { pattern: /\bSTRING_SPLIT\s*\(/i, feature: 'STRING_SPLIT', since: '2016', instead: 'a table-valued parameter' },
  { pattern: /\bTRIM\s*\(/i, feature: 'TRIM', since: '2017', instead: 'LTRIM(RTRIM(x))' },
  { pattern: /\bCONCAT_WS\s*\(/i, feature: 'CONCAT_WS', since: '2017', instead: 'CONCAT or +' },
  { pattern: /\bTRANSLATE\s*\(/i, feature: 'TRANSLATE', since: '2017', instead: 'nested REPLACE' },
  { pattern: /\bDROP\s+\w+\s+IF\s+EXISTS\b/i, feature: 'DROP ... IF EXISTS', since: '2016', instead: 'IF OBJECT_ID(...) IS NOT NULL DROP ...' },
  { pattern: /\bCREATE\s+OR\s+ALTER\b/i, feature: 'CREATE OR ALTER', since: '2016 SP1', instead: 'IF OBJECT_ID(...) IS NULL CREATE ... else ALTER' },
  { pattern: /\bOPENJSON\s*\(/i, feature: 'OPENJSON', since: '2016', instead: 'parse JSON in Node' },
  { pattern: /\bJSON_VALUE\s*\(/i, feature: 'JSON_VALUE', since: '2016', instead: 'parse JSON in Node' },
  { pattern: /\bJSON_QUERY\s*\(/i, feature: 'JSON_QUERY', since: '2016', instead: 'parse JSON in Node' },
  { pattern: /\bJSON_MODIFY\s*\(/i, feature: 'JSON_MODIFY', since: '2016', instead: 'rewrite the value in Node' },
  { pattern: /\bFOR\s+JSON\b/i, feature: 'FOR JSON', since: '2016', instead: 'shape the result in Node' },
  { pattern: /\bAT\s+TIME\s+ZONE\b/i, feature: 'AT TIME ZONE', since: '2016', instead: 'store UTC and convert in Node' },
  { pattern: /\bDATEDIFF_BIG\s*\(/i, feature: 'DATEDIFF_BIG', since: '2016', instead: 'DATEDIFF' },
  { pattern: /\bSESSION_CONTEXT\s*\(/i, feature: 'SESSION_CONTEXT', since: '2016', instead: 'pass values as parameters' },
  { pattern: /\bCOMPRESS\s*\(|\bDECOMPRESS\s*\(/i, feature: 'COMPRESS/DECOMPRESS', since: '2016', instead: 'compress in Node' },
  { pattern: /\bSYSTEM_VERSIONING\s*=/i, feature: 'temporal tables', since: '2016', instead: 'dbo.AuditLogs' },
  { pattern: /\bAPPROX_COUNT_DISTINCT\s*\(/i, feature: 'APPROX_COUNT_DISTINCT', since: '2019', instead: 'COUNT(DISTINCT x)' },
  { pattern: /\bGREATEST\s*\(|\bLEAST\s*\(/i, feature: 'GREATEST/LEAST', since: '2022', instead: 'CASE' },
  { pattern: /\bGENERATE_SERIES\s*\(/i, feature: 'GENERATE_SERIES', since: '2022', instead: 'a numbers table' },
]

/** Directories worth scanning; everything else is noise. */
const SQL_DIRS = ['database']
const CODE_DIRS = ['backend/src']

const problems = []

async function walk(dir, extensions) {
  const absolute = path.join(repoRoot, dir)
  const found = []
  let entries
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return found
    throw err
  }
  for (const entry of entries) {
    const full = path.join(absolute, entry.name)
    const relative = path.relative(repoRoot, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      found.push(...(await walk(relative, extensions)))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(relative)
    }
  }
  return found
}

/** Strips block and line comments so a comment cannot trip the scanner. */
function stripSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

async function checkSqlCompatibility() {
  const files = []
  for (const dir of SQL_DIRS) files.push(...(await walk(dir, ['.sql'])))

  for (const file of files) {
    const raw = await fs.readFile(path.join(repoRoot, file), 'utf8')
    const text = stripSqlComments(raw)
    const lines = text.split('\n')

    for (const rule of FORBIDDEN_TSQL) {
      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          problems.push(
            `${file}:${index + 1}  ${rule.feature} requires SQL Server ${rule.since}+ ` +
              `(production is 2014). Use ${rule.instead}.`,
          )
        }
      })
    }
  }
  return files.length
}

/**
 * Flags string interpolation inside query text.
 *
 * Matches .query`...${x}...`, .query(`...${x}...`) and .batch(`...${x}...`),
 * which are the ways an untrusted value could reach the server as SQL rather
 * than as a bound parameter.
 */
const INTERPOLATED_QUERY = /\.(query|batch)\s*(\(\s*)?`[^`]*\$\{[^`]*`/gs

async function checkParameterisation() {
  const files = []
  for (const dir of CODE_DIRS) files.push(...(await walk(dir, ['.ts'])))

  for (const file of files) {
    const text = await fs.readFile(path.join(repoRoot, file), 'utf8')
    for (const match of text.matchAll(INTERPOLATED_QUERY)) {
      const line = text.slice(0, match.index).split('\n').length
      problems.push(
        `${file}:${line}  Interpolated value inside SQL text. ` +
          `Use request.input('name', sql.Type, value) and reference @name instead.`,
      )
    }
  }
  return files.length
}

const sqlCount = await checkSqlCompatibility()
const codeCount = await checkParameterisation()

if (problems.length > 0) {
  console.error('SQL safety check FAILED:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s) found.`)
  process.exit(1)
}

console.log(
  `SQL safety check passed (${sqlCount} .sql file(s), ${codeCount} .ts file(s) scanned).`,
)
