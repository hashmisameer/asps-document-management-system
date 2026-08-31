# ASPS Document Management System

Internal employee document management for **ASPS International**.

Manages employee records, a configurable document checklist, submission
deadlines, and signature placement on scanned documents. Runs on the company's
own Windows server against Microsoft SQL Server 2014, over the internal LAN.

> **Status: Milestone 1 (Foundation) - partially complete.**
> The API process, shared business rules and safety checks run. The schema and
> migration runner are written and typechecked but have **not yet been run
> against a real database**, because no SQL Server instance is available yet.
> See [`docs/open-questions.md`](docs/open-questions.md) item B1.
>
> The API starts and serves requests without a database: it reports the
> connection failure at boot and answers `GET /api/health/ready` with 503 until
> SQL Server is reachable.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript, Tailwind, TanStack Query, Recharts |
| Backend | Node.js + Express 5 + TypeScript (modular monolith) |
| Database | Microsoft SQL Server 2014 via `mssql`/`tedious` (pure JS, no ODBC) |
| Auth | Server-side revocable sessions, httpOnly cookie, `crypto.scrypt` hashing |
| PDF | `pdf-lib` (stamping), `pdfjs-dist` + `@napi-rs/canvas` (rasterising) |
| OCR / CV | `tesseract.js` (WASM) and a pure-JS morphology detector, behind a provider interface |
| Storage | Secure folder on the company server, outside the web root |

No MongoDB. No native build toolchain required on the server.

## Layout

```
shared/     Types, Zod schemas, business rules and pure utilities used by BOTH sides
backend/    Express API: routes -> controllers -> services -> repositories
frontend/   React SPA
database/   Numbered forward-only migrations and idempotent seeds
docs/       Architecture, open questions, SQL Server 2014 notes, coordinate system
scripts/    Build-blocking safety checks
```

## Getting started

Requires Node.js 20+ and access to a SQL Server 2014 instance.

```bash
npm install

cp backend/.env.example backend/.env
# Fill in DB_* and generate SESSION_SECRET:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

npm run db:status     # verifies connectivity and reports the server version
npm run db:migrate    # applies pending migrations
npm run db:seed       # roles, and the confirmed document types

npm run dev           # backend + frontend
```

The API listens on `http://localhost:4000` and the SPA on
`http://localhost:5173`, which proxies `/api` to the backend so the session
cookie behaves exactly as it will in production.

## API

Every response that is not a success uses one envelope, so the frontend has a
single error path:

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",  // stable; branch on this, never on the message
    "message": "...",             // written for the user, may be reworded
    "details": { "issues": [] },  // 4xx only: which fields, and why
    "referenceId": "uuid"         // 5xx only: matches X-Request-Id in the log
  }
}
```

Codes live in [`shared/src/constants/errors.ts`](shared/src/constants/errors.ts)
so both sides agree on them. A 5xx never carries the underlying reason: the real
error goes to the log against the request id, and the caller gets that id.

Every response carries `X-Request-Id`. An inbound one is ignored rather than
trusted, so a caller cannot choose its own log correlation id.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness. Never touches the database, safe to poll. |
| `GET /api/health/ready` | Readiness. Round-trips to SQL Server; 503 when it cannot. |

## Checks

```bash
npm run verify              # lint + typecheck + SQL safety + secrets + tests
npm run check:sql-safety    # blocks 2016+ T-SQL and interpolated SQL
npm run check:secrets       # blocks committed credentials, keys, scans, PAN/Aadhaar
npm run test                # unit tests
```

`check:sql-safety` exists because production is SQL Server 2014 while developers
are likely to have something newer: it fails the build on T-SQL that needs a
later version, and on any value interpolated into query text instead of being
bound as a parameter.

`check:secrets` scans everything that would be committed - what git tracks, plus
untracked files `.gitignore` does not already exclude - for `.env` files, private
keys, database backups, document scans, hard-coded credentials and values shaped
like a PAN or Aadhaar number. A reviewed exception is marked with
`asps-dms:allow-secret` on the flagged line or the line above it.

## Documentation

- [`docs/open-questions.md`](docs/open-questions.md) - what the company still needs to confirm, and every standing assumption
- [`docs/sql-server-2014-notes.md`](docs/sql-server-2014-notes.md) - 2014 constraints and the Node/TLS connection risk
- [`docs/coordinate-system.md`](docs/coordinate-system.md) - how signature placements stay accurate across zoom, DPI and page rotation

## Security

Employee documents are sensitive. Never commit `.env`, real documents,
signatures, database credentials or employee data. Document storage lives
outside the repository and outside the web root, and files are served only
through authenticated, authorised endpoints.
