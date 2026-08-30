# SQL Server 2014 notes

Production runs **Microsoft SQL Server 2014** (major version 12, compatibility
level 120). This file records what that constrains and how the constraint is
enforced automatically rather than by memory.

## Enforcement

`npm run check:sql-safety` runs in `npm run verify` and fails the build on:

- T-SQL that requires a SQL Server newer than 2014, anywhere under `database/`
- string interpolation inside query text, anywhere under `backend/src/`

`npm run db:status` prints the connected server's version and warns when it is
newer than 2014, because developing against a newer server is how a 2016+
construct reaches production unnoticed.

## Not available in 2014 - and what to use instead

| Feature | Since | Use instead |
|---|---|---|
| `STRING_AGG` | 2017 | `FOR XML PATH`, or aggregate in Node |
| `TRIM` | 2017 | `LTRIM(RTRIM(x))` |
| `CONCAT_WS` | 2017 | `CONCAT` or `+` |
| `TRANSLATE` | 2017 | nested `REPLACE` |
| `DROP ... IF EXISTS` | 2016 | `IF OBJECT_ID(...) IS NOT NULL DROP ...` |
| `CREATE OR ALTER` | 2016 SP1 | `IF OBJECT_ID(...) IS NULL CREATE ...` else `ALTER` |
| JSON (`OPENJSON`, `JSON_VALUE`, `FOR JSON`) | 2016 | `NVARCHAR(MAX)`, parsed in Node |
| `STRING_SPLIT` | 2016 | a table-valued parameter |
| `AT TIME ZONE` | 2016 | store UTC, convert in Node |
| `DATEDIFF_BIG` | 2016 | `DATEDIFF` |
| Temporal tables | 2016 | `dbo.AuditLogs` |
| Row-Level Security | 2016 | authorisation in the service layer |
| `GREATEST` / `LEAST` | 2022 | `CASE` |

## Available in 2014, and used

- `OFFSET ... FETCH NEXT` (2012+) - all server-side pagination
- `SEQUENCE` (2012+) - `dbo.EmployeeCodeSeq` for employee codes
- `TRY_CONVERT`, `IIF`, `FORMAT` (2012+) - `FORMAT` avoided in hot paths, it is slow
- Filtered indexes (2008+) - one active document per employee/type, one active signature per employee
- `DATE`, `DATETIME2`, `SYSUTCDATETIME()` (2008+)
- `MERGE` (2008+) - idempotent seeds

## Risk R1: TLS handshake between modern Node and SQL Server 2014

**This is the most likely thing to fail on first connection.**

Node 20+ ships OpenSSL 3, which refuses the older TLS versions and small
Diffie-Hellman keys that a stock SQL Server 2014 offers. Typical symptoms:

```
ConnectionError: Failed to connect to <host>:1433 - self signed certificate
ConnectionError: ... unsupported protocol
ConnectionError: ... dh key too small
```

Mitigations, in order of preference:

1. **On a trusted LAN, do not negotiate TLS at all.** This is the default in
   `.env.example`:
   ```
   DB_ENCRYPT=false
   DB_TRUST_SERVER_CERTIFICATE=true
   ```
2. **Patch the server.** TLS 1.2 support requires SQL Server 2014 **SP2**, or
   **SP1 CU6** or later. Worth confirming with IT regardless.
3. **Last resort**, if encryption is required and the server cannot be patched:
   ```
   NODE_OPTIONS=--tls-min-v1.0
   ```
   This weakens TLS process-wide, so prefer 1 or 2.

**Not yet verified against a real server** - no SQL Server instance is available
on the development laptop (see `open-questions.md` B1). Proving this connection
is the first task once a database exists.

## Driver choice

`mssql` on top of `tedious`: a pure JavaScript TDS implementation. No ODBC
driver and no native build toolchain is needed on the company's Windows server,
which matters because that server is unlikely to have Visual Studio build tools
installed.

## Connecting to a named instance

Set `DB_INSTANCE` **or** `DB_PORT`, never both - a named instance is resolved by
the SQL Server Browser service, which makes an explicit port meaningless. The
env validator rejects the combination at boot rather than producing a confusing
connection timeout. A named instance also requires the **SQL Server Browser**
service to be running and UDP 1434 to be reachable.
