# ASPS Document Management System

Internal employee document management for **ASPS International**.

Manages employee records, a configurable document checklist, submission
deadlines, and signature placement on scanned documents. Runs on the company's
own Windows server against Microsoft SQL Server 2014, over the internal LAN.

> **Status: Milestones 1-5 complete in code.** The API process, authentication, the
> signed-in SPA shell, employee management with its document checklist, document
> upload, verification and secure file serving, the identity check that reads an
> upload and compares it with the employee record, pen-tablet signature capture
> for both the employee and the authorising user, placement and PDF stamping,
> shared business rules and safety checks run and are unit-tested.
> The schema, all three migrations and the seeds **have now been applied to a
> real SQL Server 2014 Express instance**, and the signing path has been driven
> end to end against it: an upload that passes the identity check, an employee
> and an authoriser signature, placements saved, and the signed PDF regenerated.
> Reports and user administration remain placeholders (Milestone 6).
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
| `GET /api/documents/:id` | One document, with its deadline state. |
| `POST /api/documents/:id/file` | Uploads or replaces the file (multipart). Refused with 422 `IDENTITY_CHECK_FAILED` unless a reason is given. |
| `POST /api/documents/:id/verify` | Marks it verified. |
| `POST /api/documents/:id/reject` | Rejects it. A reason is required. |
| `PATCH /api/documents/:id/deadline` | Overrides this document's deadline. |
| `GET /api/documents/:id/preview` | Streams it inline. |
| `GET /api/documents/:id/download` | Streams it as an attachment. |
| `GET /api/me/signature` | The signed-in user's own authorising signature. |
| `POST /api/me/signature` | Saves it, as drawn on the pad (multipart). |
| `GET /api/me/signature/image` | Streams it. |
| `POST /api/reminders/send` | Emails the pending-documents digest now. `?dryRun=true` renders it without sending. |
| `GET /api/employees/:id/signature` | Whether a signature is on file, and its size. |
| `POST /api/employees/:id/signature` | Uploads or replaces it (multipart). |
| `GET /api/employees/:id/signature/image` | Streams the signature image. |
| `GET /api/documents/:id/placements` | Where the signature goes on this document. |
| `PUT /api/documents/:id/placements` | Replaces them all and regenerates the signed PDF. |
| `POST /api/documents/:id/skip-signature` | Records that no signature is needed. |

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
- **The placement editor never stores a pixel.** pdf.js renders the page at
  whatever size the layout gives it, the boxes are dragged over it, and what is
  saved is normalized to the displayed page with the page's own `/Rotate`
  beside it - so a placement means the same spot on a laptop, at 150% zoom, and
  in the 300 DPI raster the stamper works from. The editor and the stamper share
  one coordinate module rather than each keeping their own arithmetic, which is
  how a preview and its output drift apart. A drag is clamped to the page; a
  save is validated, and an out-of-bounds placement is refused rather than
  quietly corrected. The pdf.js worker is bundled rather than fetched from a
  CDN, because the company server has no route to the internet.
- **A refused upload opens the override, not a dead end.** When the identity
  check turns a document away, the form names the details that could not be
  found and asks for a reason, then re-sends the same file with it. A refusal
  whose message says "accept it with a reason" while offering nowhere to write
  one would read as a bug the first time HR met it.
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

## Documents

- **The content decides what a file is**, not its name and not the Content-Type
  the browser attached: both are chosen by the caller. A `.exe` renamed to
  `.pdf` is rejected because its first bytes are not a PDF's, and a real PDF
  named `.png` is rejected too, because everything downstream decides what to do
  from the type.
- **The stored name is a UUID.** An uploaded name can contain path separators,
  can collide with another employee's file, and is itself personal data sitting
  in a directory listing. What is stored in the database is the path *relative*
  to the storage root, so the volume can move without rewriting every row, and
  every path read back is re-resolved and checked to be inside the store before
  it is opened.
- **Validate, write the file, then update the row.** If the row fails to save
  the file is removed again: an orphaned file is recoverable housekeeping, while
  a row pointing at a file that was never written is a document nobody can open.
- **Every status change goes through the state machine** in
  `shared/src/constants/documents.ts`. A change it does not permit is a 409 with
  `INVALID_STATE_TRANSITION`, never a silent write - so replacing a *verified*
  document re-opens it as Uploaded rather than staying verified on the strength
  of a file nobody has looked at. The current status is part of the UPDATE's
  WHERE clause, so two people verifying at once cannot both succeed.
- **Uploading and replacing are separate permissions**, and only the row knows
  which a request is: the route requires `DOCUMENT_UPLOAD`, and the service
  additionally requires `DOCUMENT_REPLACE` when a file is already there.
- **Preview and download are separate routes** because they are separate
  permissions (open question Q6). Both are ordinary authenticated requests -
  there is no signed URL and no token in a query string - and both send
  `Cache-Control: private, no-store`, because an employee's document must not
  sit in a shared cache.
- **A replacement voids prior signature work.** A placement describes a page in
  a file that is no longer served, so the signature status starts over rather
  than being carried forward onto a document nobody has placed it on.

## Document identity check

- **An upload is read and compared with the employee's own record**, so a form
  belonging to one person cannot be filed against another. Which details a
  document must confirm is configuration held on the document type, not a rule
  in code: a service card asks for the name, code and Aadhaar number, while a
  qualification certificate asks for the name only.
- **The file is read before it is stored.** A document that is going to be
  refused should never have been written to the store in the first place.
- **Two ways of reading, and which one was used is recorded.** A PDF's own text
  layer is exact - those are the characters the file contains. A scan or a
  photograph has no text layer, so its pages are rendered and OCR'd, which is
  good but not exact. A text layer shorter than 60 characters is treated as
  absent rather than as an answer, because a scanned PDF usually carries a
  scanner watermark or a page number, and checking a service card against the
  word "Scanned" would refuse a document OCR would have read perfectly.
- **The check is a guard, not a judgement of authenticity.** It is deliberately
  literal about what counts as a match, because the cost of being lenient is
  exactly the mistake being guarded against. Matching is per field rather than
  per document: a date matches in any of the formats a document writes it in, a
  name matches regardless of order or case, and a digit string matches through
  the spacing an identity number is usually printed with.
- **A detail the office never recorded does not fail anything.** It comes back
  `MissingOnRecord` and is reported. Refusing a document because an employee's
  phone number was never typed in would send HR to rescan a document that was
  always fine, while reporting the gap makes the real fix the obvious one.
- **A failure can be overridden by a person, in their own name.** A real
  document can fail because a scan is too poor for OCR to read a digit, so the
  refusal is a 422 `IDENTITY_CHECK_FAILED` carrying the per-field outcome, and
  the same upload succeeds when it names a reason. The outcome, the reason and
  who gave it are stored **on the document**, not only in the audit trail:
  "this service card was accepted although its Aadhaar number could not be
  read" has to be visible months later without knowing to go looking.
- **A refusal is audited even though nothing was stored.** An upload that was
  turned away is exactly the event this control exists to make visible, and it
  leaves no other trace - there is no document row to look at afterwards.
- **An identity number is never echoed back.** A refusal names the detail that
  could not be found, and for a name or a joining date it says what was
  expected, because that is what makes the message useful. For an Aadhaar, PAN,
  UAN or ESI number it reports the label only, since doing otherwise would turn
  the upload form into a way of reading one. The same numbers are redacted from
  audit metadata and logs, where they would outlive every control on the record
  they came from.
- **The whole check can be switched off** with `IDENTITY_CHECK_ENABLED`, and a
  check that did not run is recorded as `NotChecked` - a different answer from
  one that ran and passed. On the company server, which has no route to the
  internet, the Tesseract language data must be vendored locally or every OCR
  pass fails; see `backend/.env.example`.

## Signatures

- **Two people sign a document**: the employee, and the HR user who authorises
  it. `SignerRole` on a placement is what says which, and the authoriser is
  always the user saving the placements - never a user id the request names - so
  nobody can sign a document off in a colleague's name.
- **Both signatures are drawn on a pen tablet**, not uploaded as files. The pad
  is an ordinary canvas driven by pointer events, so it needs no vendor SDK and
  no bridge process: with its Windows driver installed, the tablet is just a pen
  device. Pen pressure varies the stroke width, and the ink is cropped to its
  own bounds and stored as a transparent PNG - an uncropped canvas would stamp a
  small signature floating in a large empty box.
- **One signature per employee**, enrolled once and reused on everything they
  sign (Section 24). Each HR user has their own, in `dbo.UserSignatures`, so a
  signed document records who authorised it. Replacing either does *not*
  re-stamp documents that were already signed: those carry the image that was
  current when they were issued.
- **The image is measured by embedding it exactly as the stamper will.** That
  records its pixel size, and it also catches a progressive JPEG - which
  `pdf-lib` cannot embed - while someone is looking at an upload form, rather
  than later, when the failure would appear to be about the document.
- **The signed PDF is always rebuilt from the ORIGINAL** (Sections 34 and 64).
  Stamping the previous output would compound every placement ever made, and a
  corrected placement would leave the wrong one visible underneath the right
  one. Saving placements is therefore a `PUT` of the complete set; an empty set
  removes the signature and drops the processed file.
- **The output is always a PDF** (open question Q8), so an image document
  becomes a one-page PDF sized to the image. The processed copy is served in
  preference to the original, and is served as `application/pdf` whatever the
  original was.
- **A page that has been rotated since a placement was made is refused**, not
  drawn. The coordinates describe the page as HR saw it; if it has since turned,
  they describe somewhere else. A signature in the wrong place on a real
  document is the failure the whole coordinate module exists to prevent, so it
  fails loudly and asks for the placement to be made again.
- **Nothing places a signature on its own.** Detection, when it lands, produces
  candidates; only an explicit save draws anything (standing assumption 8).

The coordinate contract - normalized 0..1, top-left origin, `pageRotation`
carried alongside, no pixel or zoom value ever stored - is in
[`docs/coordinate-system.md`](docs/coordinate-system.md). The pdf-lib
anchor-and-rotate maths that turns a placement into a draw call lives with the
stamper, not in the shared module, because the browser editor has no use for it;
both its four rotations and the shared transform are pinned to absolute values
in the tests rather than round-tripped.

## Reminders

- **One email, to several people, listing who still owes what.** Each entry is
  the employee's code and name and the documents with no file against them,
  worst deadline first. `REMINDER_RECIPIENTS` is a comma-separated list, because
  who gets chased is an office decision rather than a code change.
- **It repeats until the file is uploaded.** The digest is rebuilt from the
  current state on every run and nothing is stored about a reminder having been
  sent, so there is no record to drift out of step with the checklist. A
  document stops appearing the moment its file arrives, and not before.
- **Pending means no file, not a status.** A rejected document still has no
  acceptable file against it, and a reminder that stopped at `Rejected` would
  drop exactly the documents most in need of chasing.
- **A document that is not due yet is left out**, unless
  `REMINDER_INCLUDE_NOT_YET_DUE` says otherwise. Every new employee starts with
  ten future documents, and listing them from day one makes the digest a copy of
  the checklist that nobody reads. A document with no deadline at all is still
  included: it is genuinely outstanding.
- **Nothing is sent when nothing is outstanding.** A daily email saying all is
  well teaches people to delete it unread, and takes the one that mattered with
  it.
- **The daily run is a separate process**, `npm run send-reminders`, scheduled
  by Windows Task Scheduler - not a timer inside the API, which would stop at
  the next restart and would send twice if the API were ever run as two
  processes. A hung mail server cannot wedge the API either. `-- --dry-run`
  prints what would go out and sends nothing.
- **Sending is off until `REMINDER_ENABLED` is set**, so a freshly deployed
  server cannot start emailing the office by itself. A dry run works regardless,
  which is how the wording gets checked before anyone is on the receiving end.

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
