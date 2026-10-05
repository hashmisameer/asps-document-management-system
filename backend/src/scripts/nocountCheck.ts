/**
 * READ-ONLY. Is any pooled connection carrying SET NOCOUNT ON?
 *
 *   npm run nocount-check --workspace backend
 *
 * Why this exists: PATCH /documents/:id/not-required answered 409 'Someone
 * else changed this document a moment ago' while the write had in fact
 * succeeded. The cause is SET NOCOUNT. With it ON, SQL Server sends no row
 * counts, mssql reports rowsAffected as [], and every repository function that
 * decides what happened from rowsAffected[0] reads 'no count' as 'no rows'.
 *
 * All 39 migrations and all 3 seeds begin 'SET NOCOUNT ON;'. NOCOUNT is a
 * SESSION setting, so a connection that ran one carries it for the rest of its
 * life in the pool - which is exactly what happens in the integration tests,
 * where ensureSchema() runs them through the same pool the requests then use.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU. It opens its OWN pool, with the API's
 * configuration, in its own process: it cannot read the connections the
 * running pm2 process is holding, because SQL Server exposes no per-session
 * NOCOUNT anywhere a query can reach. What it does answer is the two things
 * that would make the API's pool dirty no matter what it runs:
 *
 *   1. Does a freshly opened connection already have NOCOUNT ON? That would
 *      mean the server's own 'user options' default, or a logon trigger, sets
 *      it - and then every API connection has it too.
 *   2. Is the server-wide 'user options' default carrying bit 512?
 *
 * If both say no, and the API process never runs a migration or a seed (it
 * does not - nothing outside database/cli.ts calls them), then the API's
 * connections are clean.
 *
 * It writes nothing. Every statement is a SELECT, plus a WAITFOR DELAY used to
 * hold several connections open at once so that more than one is sampled.
 */
import { env } from '../config/env.js'
import { closePool, createRequest, getPool, sql } from '../database/pool.js'
import { describeError } from '../utils/errors.js'

/** NOCOUNT is bit 512 of @@OPTIONS, and of the 'user options' default. */
const NOCOUNT_BIT = 512

/** Long enough that the samples overlap and the pool has to open more. */
const HOLD = '00:00:00.400'

interface Sample {
  Spid: number
  NoCount: number
  AllOptions: number
  LoginName: string
  DatabaseName: string
}

/** The columns every sample reads. Names only; the delay is bound. */
const SAMPLE_COLUMNS = `
      SELECT @@SPID                      AS Spid,
             @@OPTIONS & ${NOCOUNT_BIT}  AS NoCount,
             @@OPTIONS                   AS AllOptions,
             SUSER_SNAME()               AS LoginName,
             DB_NAME()                   AS DatabaseName`

/**
 * One connection's settings.
 *
 * `hold` keeps the connection occupied for that long, so callers running in
 * parallel are each given a DIFFERENT connection rather than taking turns on
 * one - WAITFOR DELAY is the only way to make a read-only query occupy its
 * connection for a known time. It is BOUND, not written into the SQL: a delay
 * is a value like any other.
 */
async function sample(hold?: string): Promise<Sample> {
  const request = await createRequest()
  const result = hold
    ? await request
        .input('hold', sql.VarChar(12), hold)
        .query<Sample>(`WAITFOR DELAY @hold;${SAMPLE_COLUMNS}`)
    : await request.query<Sample>(SAMPLE_COLUMNS)

  const row = result.recordset[0]
  if (!row) throw new Error('the connection answered nothing')
  return row
}

async function serverDefault(): Promise<number | null> {
  try {
    const request = await createRequest()
    const result = await request.query<{ ValueInUse: number }>(
      `SELECT CAST(value_in_use AS INT) AS ValueInUse
       FROM   sys.configurations WHERE name = 'user options'`,
    )
    return result.recordset[0]?.ValueInUse ?? null
  } catch (error) {
    console.log(`  (could not read the server default: ${describeError(error)})`)
    return null
  }
}

async function logonTriggers(): Promise<string[] | null> {
  try {
    const request = await createRequest()
    const result = await request.query<{ name: string }>(
      `SELECT name FROM sys.server_triggers WHERE is_disabled = 0`,
    )
    return result.recordset.map((row) => row.name)
  } catch {
    // Needs a server-level permission the application's login does not have,
    // which is correct for it to lack. Not knowing is reported, not guessed.
    return null
  }
}

async function main(): Promise<void> {
  const pool = await getPool()

  console.log(
    `NOCOUNT check - read-only\n` +
      `  server    : ${env.DB_HOST}${env.DB_INSTANCE ? `\\${env.DB_INSTANCE}` : ''}\n` +
      `  database  : ${env.DB_NAME}\n` +
      `  pool      : min ${env.DB_POOL_MIN}, max ${env.DB_POOL_MAX}\n` +
      `  this is a NEW pool in THIS process, with the API's configuration;\n` +
      `  it cannot read the connections the running API is holding.\n`,
  )

  // As many at once as the pool will give, so several connections are sampled
  // rather than one being asked several times.
  const wanted = Math.min(env.DB_POOL_MAX, 8)
  const concurrent = await Promise.all(
    Array.from({ length: wanted }, () => sample(HOLD).catch((error: unknown) => error as Error)),
  )

  const samples: Sample[] = []
  console.log(`Sampling ${wanted} connection(s) at once:`)
  for (const result of concurrent) {
    if (result instanceof Error) {
      console.log(`  failed: ${describeError(result)}`)
      continue
    }
    samples.push(result)
    console.log(
      `  SPID ${String(result.Spid).padEnd(6)} NOCOUNT ${result.NoCount === NOCOUNT_BIT ? 'ON  <-- dirty' : 'off'}` +
        `   @@OPTIONS ${result.AllOptions}   ${result.LoginName} on ${result.DatabaseName}`,
    )
  }

  // Again, in turn, on whatever the pool hands back - a connection used once
  // and returned is the one a later request would get.
  console.log('\nSampling 5 more, one after another (reused connections):')
  for (let i = 0; i < 5; i += 1) {
    try {
      const again = await sample()
      samples.push(again)
      console.log(
        `  SPID ${String(again.Spid).padEnd(6)} NOCOUNT ${again.NoCount === NOCOUNT_BIT ? 'ON  <-- dirty' : 'off'}`,
      )
    } catch (error) {
      console.log(`  failed: ${describeError(error)}`)
    }
  }

  const spids = new Set(samples.map((row) => row.Spid))
  const dirty = samples.filter((row) => row.NoCount === NOCOUNT_BIT)

  console.log('\nThe server-wide default:')
  const userOptions = await serverDefault()
  if (userOptions !== null) {
    console.log(
      `  'user options' = ${userOptions}` +
        `  -> NOCOUNT ${(userOptions & NOCOUNT_BIT) === NOCOUNT_BIT ? 'ON for every new connection  <-- this would affect the API' : 'off by default'}`,
    )
  }

  const triggers = await logonTriggers()
  console.log(
    triggers === null
      ? '  logon triggers: cannot be read with this login (needs a server-level permission)'
      : `  logon triggers: ${triggers.length === 0 ? 'none' : triggers.join(', ')}`,
  )

  console.log(
    `\n${samples.length} sample(s) across ${spids.size} distinct connection(s); ` +
      `${dirty.length} carrying NOCOUNT ON.`,
  )
  if (dirty.length === 0 && (userOptions === null || (userOptions & NOCOUNT_BIT) === 0)) {
    console.log(
      'A fresh pool with the API’s configuration is CLEAN, and the server sets\n' +
        'no default. Nothing in the API process runs a migration or a seed, so its\n' +
        'connections have no way to acquire NOCOUNT ON either.',
    )
  } else {
    console.log(
      'NOCOUNT ON is reaching connections from the configuration or the server\n' +
        'itself, which means the API’s pool has it too: every rowsAffected check\n' +
        'in the repositories is unreliable on this server.',
    )
  }

  console.log(
    `\n(pool reported ${pool.connected ? 'connected' : 'not connected'}; nothing was written)`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(`\n${describeError(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
