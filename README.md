# ASPS Document Management System

Internal employee document management for **ASPS International**.

Manages employee records, a configurable document checklist, submission
deadlines, and signature placement on scanned documents. Runs on the company's
own Windows server against Microsoft SQL Server 2014, over the internal LAN.

> **Status: Milestones 1-2 complete in code; Milestone 3 (employee records)
> landed.** The API process, authentication, the signed-in SPA shell, employee
> management with its document checklist, shared business rules and safety
> checks run and are unit-tested. The schema, migration runner and every SQL query are
> written and typechecked but have **not yet been run against a real database**,
> because no SQL Server instance is available yet - so nothing that reads or
> writes a table has been exercised end to end.
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

# The first login. Prints a temporary password once; the user must change it.
npm run db:create-user -- --username admin --name "Full Name" --role ADMIN

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
| `POST /api/auth/login` | Sign in. Sets the session cookie. |
| `POST /api/auth/logout` | Revokes the session and clears the cookie. |
| `GET /api/auth/me` | The signed-in user. |
| `POST /api/auth/change-password` | Changes own password; ends every other session. |
| `GET /api/employees` | Paginated list with search, filters, sorting and checklist counts. |
| `GET /api/employees/facets` | The departments and designations in use, for the filters. |
| `POST /api/employees` | Creates an employee and materialises their checklist. |
| `GET /api/employees/:id` | One employee, with counts and signature state. |
| `PATCH /api/employees/:id` | Updates the details. The employee code is immutable. |
| `POST /api/employees/:id/archive` | Archives. There is no DELETE. |
| `POST /api/employees/:id/restore` | Restores an archived employee. |
| `GET /api/employees/:id/documents` | The checklist, with deadline state derived at read time. |
| `GET /api/document-types` | The configured checklist. Read-only until Settings. |

Health and auth are mounted before the authentication gate; everything else is
mounted underneath it, so a new feature router is authenticated by where it is
mounted rather than by each route remembering to ask.

## Frontend

A single-page React app. `/login` is the only route outside the gate;
everything else goes through `ProtectedRoute`, which sends a signed-out user to
the login form and an account with `MustChangePassword` to the one page that
lets it set a password.

- **No token is ever held in JavaScript.** The session lives in an httpOnly
  cookie the browser sends because the API client sets `withCredentials`. There
  is nothing in `localStorage`, so closing the tab leaves nothing behind on a
  shared office machine, and signing out clears the whole query cache so the
  next person sees none of the previous user's data.
- **Forms validate with the same Zod schemas as the API**, so the two cannot
  disagree about what is acceptable. The client check saves a round trip; the
  server rejects the same input again regardless.
- **Navigation is built from permissions**, not roles, so an Admin and a Viewer
  get different menus from the same code. The employee pages read the same map:
  a Viewer sees the list and the checklist, and no button that would change
  either.
- **Calendar values are rendered in UTC**, so a joining date shows the day it
  says. Timestamps are rendered in the reader's own timezone, because those are
  real instants.
- **Every failure becomes one `ApiError`**, so a component never sees an axios
  error. A request that never reached the server says so rather than reporting a
  generic failure.

## Authentication

Local accounts only - no Active Directory, LDAP or Entra ID (Section 84).

- **Passwords** are scrypt with a per-user salt, and the parameters are stored
  with the hash so the cost can be raised later and upgraded on next sign-in.
  The policy is length-led: 12 characters, with an upper, a lower and a digit.
- **Sessions** are server-side and revocable. The cookie carries a 256-bit
  random token and nothing else; only its SHA-256 is stored, so a leak of
  `dbo.Sessions` yields no usable session. The cookie is httpOnly and SameSite
  lax, with a sliding idle expiry under a fixed absolute ceiling.
- **A failed sign-in says nothing.** Wrong password, unknown username and
  deactivated account all return the same 401. Five failures lock the account
  for fifteen minutes; the reasons go to `dbo.AuditLogs`, not to the caller.
- **Authorisation is permission-based**, from `ROLE_PERMISSIONS` in
  `shared/src/constants/roles.ts`. The frontend reads the same map to decide
  what to render, but every check that matters is server-side.
- **Accounts are created from the CLI**, never from a seed file, so no password
  is ever committed:

  ```bash
  npm run db:create-user -- --username hr1 --name "Full Name" --role HR
  ```

  The temporary password is printed once. `MustChangePassword` is always set,
  so whoever runs the command does not end up knowing the user's password.

## Employee records

- **The employee code is generated, never typed.** `dbo.EmployeeCodeSeq` yields
  EMP001..EMP999 and then EMP1000 onwards inside the creation transaction, so it
  keeps working past 999 without renumbering, and the UNIQUE constraint is the
  final guarantee. The API accepts no code from the client, and there is no
  route that can change one afterwards.
- **An employee and their checklist are created together or not at all.** The
  document types are read inside the same transaction as the insert, and one row
  per active type is materialised as `Pending`. A record with no checklist would
  report nothing outstanding, which looks exactly like a fully compliant
  employee - the most dangerous wrong answer this system can give.
- **Due dates are computed by the shared rules**, not by `DATEADD` in the INSERT,
  so `joiningDate + 10 DAY` has one definition (`shared/src/utils/deadline.ts`),
  one set of tests, and the browser previews the same numbers the server stores.
- **Overdue is derived at read time** from `DueDate` against today, in the counts
  query and again in the checklist, so it is correct the moment it is looked at
  and no scheduled job can leave it stale.
- **Employees are archived, never deleted.** There is no `DELETE` route.
  Archiving is idempotent: asking twice writes nothing and audits nothing,
  because an audit trail full of repeated clicks is a worse trail.

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
