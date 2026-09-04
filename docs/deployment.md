# Deploying ASPS-DMS

Written to be followed sitting at the company server. Every answer here was
checked against the code as it stands on 2026-09-04; where something does not
exist yet, it says so rather than describing what it would look like.

The server has **no route to the internet**. That shapes sections 9 and 10, and
it is the reason the OCR language files and `node_modules` need thinking about
before anybody starts.

---

## 1. What production runs

```
node backend/dist/server.js
```

Built by `npm run build` at the repository root, which builds the three
workspaces in order (`shared`, then `backend`, then `frontend`).

- The entry file comes from `backend/package.json` → `"start": "node dist/server.js"`,
  and `backend/tsconfig.json` → `"outDir": "./dist"`, `"rootDir": "./src"`.
- So `backend/src/server.ts` becomes `backend/dist/server.js`.
- The working directory must be `backend/`: the process reads `backend/.env`
  (resolved relative to the compiled file, `backend/src/config/env.ts`), and
  `DOCUMENT_STORAGE_PATH` and `LOG_DIR` are resolved against the backend folder
  when they are relative paths.

For the Windows service, point it at the Node executable with
`backend\dist\server.js` as the argument and `backend` as the working directory.

`backend/dist/` is **not** in Git - `.gitignore` ignores `dist/` - so it is
produced by a build, never cloned. See section 10 for where to run that build.

---

## 2. The OCR language files, and Git

Mixed, and two of them will not arrive with a clone. Checked with
`git ls-files` and `git check-ignore`:

| File | Size | In Git? |
| --- | --- | --- |
| `backend/eng.traineddata` | 5.0 MB | **tracked** |
| `backend/hin.traineddata` | 1.6 MB | **tracked** |
| `eng.traineddata` (repo root) | 5.0 MB | **tracked** |
| `hin.traineddata` (repo root) | 1.6 MB | **not tracked** |
| `osd.traineddata` (repo root) | 11 MB | **not tracked** |

Nothing here is *ignored* - `.gitignore` has no `*.traineddata` rule - the two
root files simply were never added. They show up as untracked in `git status`.

**What this means on the server:** a clone gives you the two files under
`backend/`, which is everything the application needs. `eng` and `hin` are the
two languages `OCR_LANGUAGES=eng+hin` asks for. `osd.traineddata` is orientation
detection and **nothing in this codebase loads it** - it can be left behind.

Two of the three root copies are duplicates of the `backend/` ones. If you want
the repository tidy, delete the root copies rather than committing them; check
`TESSERACT_LANG_PATH` first (section 8) so nothing is pointed at them.

`tesseract.js` also needs its WASM core, which is **not** in Git - it comes from
`node_modules/tesseract.js-core/`. Copy `tesseract-core-simd.wasm.js` from there
to the folder you point `TESSERACT_CORE_PATH` at.

Without these files every OCR pass fails on an offline server, and a document
that cannot be read cannot be identity-checked.

---

## 3. Document types in production

```
npm run db:seed
```

Safe and required in production. `backend/src/database/migrate.ts` refuses only
seed files whose **name contains `dev`**; there are none today. The three seeds
that run are:

- `0001_roles.sql` - the three roles
- `0002_document_types.sql` - the ten documents, with their mandatory flags and
  deadlines
- `0003_departments_designations.sql` - the 26 departments and 49 designations

They do not create themselves. Every seed is idempotent (insert-if-absent), so
running it twice changes nothing.

The document list is also stated in code, in
`shared/src/constants/documentChecklist.ts`, and the application lays that over
every row it reads. The seed and the constant are compared, line by line, by
`backend/tests/unit/documentChecklist.test.ts`, so they cannot drift apart.

---

## 4. Employee import - **this does not exist**

There is no import command. Nothing in the repository reads a spreadsheet:
no `xlsx`, `exceljs` or CSV-parsing dependency in any of the three
`package.json` files, and no script under `backend/src/scripts/` or `scripts/`
that touches employees.

So there is no dry-run flag and no expected column headers to give you - there
is nothing to give them to. The 568 employees would have to be entered by hand
through Add Employee as things stand.

If the import is wanted, it needs building, and it needs two decisions made
first (both raised before and still open):

- the department and designation spellings have to be mapped as they are
  imported, or the old spellings walk straight back into the cleaned-up
  dropdowns - see the cleanup sheet;
- the checklist rows for 568 people are materialised at creation, which is
  where every deadline is written.

---

## 5. Users

All three take arguments; none is interactive.

```
npm run user:add    -- --username rakesh --name "Rakesh Sharma" --role HR
npm run user:reset  -- --username rakesh
npm run user:list
```

- `--role` is one of `HR`, `VIEWER`, `ADMIN`.
- `user:add` also accepts `--password <password>`, but do not use it: it puts
  the password in the shell history. Left off, a temporary password is generated
  and printed **once**.
- Both `user:add` and `user:reset` set "must change password at next sign-in",
  so whoever runs the command does not end up knowing a password that keeps
  working. `user:reset` also clears any lock from failed sign-ins.
- `user:list` prints username, role, full name, and whether the account is
  disabled, still owes a password change, or has never signed in. No hashes.

There is no user-management screen, by decision: five people are set up once,
and a screen for it would be a permanent way in used twice a year.

The five real accounts are not seeded - the seed would have to carry real names,
and inventing them is not something to do to a production database. Run
`user:add` five times.

---

## 6. Migrations

```
npm run db:migrate     # apply everything pending
npm run db:status      # what is applied and what is not
```

`db:status` is how you know it finished: it lists every file in
`database/migrations/` with its state. A run that completed leaves nothing
pending. Each migration is recorded with a checksum, so an already-applied file
is skipped, and one that has been **edited since it was applied** is reported
rather than silently re-run.

`npm run db:check` confirms the connection and prints the SQL Server version
before you start.

Order on a fresh database: `db:migrate`, then `db:seed`, then `user:add`.

---

## 7. Serving the frontend - **needs a decision**

Express does **not** serve the frontend. There is no `express.static` anywhere
in `backend/src/app.ts`; the API returns JSON and files only. Two comments in
that file describe the intended arrangement:

> The SPA is served from a separate origin in development and by a static host
> in production
>
> In production the SPA is same-origin, `CORS_ORIGIN` is empty, and no CORS
> headers are sent at all.

So the design expects **one origin** in production: something serves
`frontend/dist/` and forwards `/api` to Node on port 4000. That something is not
in this repository. Two ways to finish it:

**A. IIS (or nginx) in front.** Serve `frontend/dist` as the site root, reverse
proxy `/api` to `http://localhost:4000`, and leave `CORS_ORIGIN` empty. Note
that `app.set('trust proxy', false)` is deliberate - with a proxy in front,
every request will look as though it came from the proxy, so the rate limiter
and the audit trail will record the proxy's address rather than the user's.
Turning `trust proxy` on is a one-line change but must be done **only** when a
proxy is really in front, or any client can spoof its own IP.

**B. Serve the SPA from Express.** Add `express.static('frontend/dist')` plus a
catch-all that returns `index.html` for non-`/api` paths, and set a content
security policy there (helmet's is off in the API because it serves no HTML).
One port, one service, nothing else to install. This is roughly ten lines and I
can add it - say the word.

Until one of these is done, the built frontend has nowhere to be served from.

---

## 8. Environment variables

`backend/.env`, copied from `backend/.env.example`. Validated once at boot -
a missing or malformed value stops the process with a message naming the
variable, never its value.

### Required - the process will not start without these

| Variable | Value |
| --- | --- |
| `DB_HOST` | SQL Server hostname |
| `DB_NAME` | database name |
| `DB_USER` | SQL login |
| `DB_PASSWORD` | its password |
| `DOCUMENT_STORAGE_PATH` | folder for uploaded documents, outside the web root. Relative paths resolve against `backend/` |
| `SESSION_SECRET` | at least 32 characters. Generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |

### Set these in production, though they have defaults

| Variable | Default | What to set |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` |
| `PORT` | `4000` | as you like |
| `HOST` | `0.0.0.0` | `0.0.0.0` for the LAN |
| `COOKIE_SECURE` | `false` | `true` **if served over HTTPS**. Leave false on plain HTTP or nobody can sign in |
| `CORS_ORIGIN` | empty | leave empty - same-origin in production |
| `TESSERACT_LANG_PATH` | unset | the folder holding `eng.traineddata` and `hin.traineddata`. **Required offline** |
| `TESSERACT_CORE_PATH` | unset | `.../tesseract-core-simd.wasm.js`. **Required offline** |
| `TESSERACT_CACHE_PATH` | unset | a writable folder for tesseract.js to cache into |
| `REPORT_RECIPIENTS` | empty | who gets the daily email, comma-separated |
| `REPORT_SEND_TIME` | `09:00` | HH:MM on the server's clock |
| `SMTP_HOST` | unset | the internal mail relay. Required if `REPORT_RECIPIENTS` is set |
| `SMTP_FROM` | unset | the From address |
| `LOG_DIR` | `./logs` | resolved against `backend/` |

### Optional, sensible defaults

`DB_PORT` (1433), `DB_INSTANCE` (named instance - set this **or** `DB_PORT`,
never both), `DB_ENCRYPT` (false), `DB_TRUST_SERVER_CERTIFICATE` (true),
`DB_CONNECTION_TIMEOUT_MS` (15000), `DB_REQUEST_TIMEOUT_MS` (30000),
`DB_POOL_MAX` (10), `DB_POOL_MIN` (0), `SESSION_COOKIE_NAME` (`asps_dms_sid`),
`SESSION_IDLE_TTL_MINUTES` (480), `SESSION_ABSOLUTE_TTL_HOURS` (24),
`COOKIE_SAME_SITE` (`lax`), `MAX_UPLOAD_MB` (25),
`IDENTITY_CHECK_ENABLED` (true), `IDENTITY_CHECK_MAX_PAGES` (5),
`IDENTITY_CHECK_TIMEOUT_MS` (90000), `OCR_LANGUAGES` (`eng+hin`),
`OCR_PRIMARY_LANGUAGES` (`eng`), `REPORT_INCLUDE_NOT_YET_DUE` (false),
`SMTP_PORT` (25), `SMTP_SECURE` (false), `SMTP_USER`, `SMTP_PASSWORD`
(both optional - an internal relay usually needs neither), `LOG_LEVEL` (`info`),
`REGISTRATION_SECRET` (a shared code for the registration form; the five-account
cap is the real control).

### Development only - do not set in production

- `IDENTITY_CHECK_LOG_TEXT` - writes the text a document was read as into the
  log when a check fails. That puts document contents in a log file, which is
  the one place this system otherwise never puts them.
- `CORS_ORIGIN=http://localhost:5173` - only the Vite dev server needs it.
- The three `TESSERACT_*` paths are the reverse: unset in development, where
  tesseract.js fetches from a CDN, and **required** on the offline server.

Two rules the validator enforces: `REPORT_RECIPIENTS` without `SMTP_HOST` is
refused (somebody expecting an email that can never arrive), and
`COOKIE_SAME_SITE=none` requires `COOKIE_SECURE=true` in production.

---

## 9. `npm install` with no internet

`npm install` needs the registry, so it cannot run on the server. Three ways,
best first.

**A. Copy `node_modules` from a machine with the same OS and architecture.**
The server is Windows x64; build on Windows x64. This works because several
dependencies ship **platform-specific binaries** rather than JavaScript:

- `sharp` → `@img/sharp-win32-x64`
- `@napi-rs/canvas` → a `.node` binary
- `tesseract.js-core` → the WASM core

Install on the laptop, then copy the whole tree - the repository root
`node_modules/` **and** `backend/node_modules/`, `frontend/node_modules/`,
`shared/node_modules/` if they exist. npm workspaces hoist most packages to the
root and leave symlinks for the three workspace packages, so copying only one of
them leaves a broken tree.

**B. An offline npm cache.** On the laptop, `npm ci --cache ./npm-cache`, copy
`npm-cache` to the server, then `npm ci --cache ./npm-cache --offline`. Tidier
than copying `node_modules`, and it still needs the same OS and architecture for
the binaries above.

**C. An internal registry.** Verdaccio on the office network. Worth it only if
this happens often.

Whichever you choose, node must be **20 or newer** (`package.json` → `engines`)
and the repository pins **22** in `.nvmrc`. Match the laptop to the server.

**Keep the devDependencies.** Do not install with `--omit=dev` on the server:
every database and user command runs through `tsx`, which is a devDependency -
`backend/package.json` runs them as `tsx src/database/cli.ts <command>`. Strip
the dev packages and `db:migrate`, `db:seed` and `user:add` all stop working,
while the API itself carries on fine, so it is a failure that only turns up the
first time somebody needs to add a user.

---

## 10. Where to build

**On the laptop, then copy.** The server has no internet, and:

- `npm run build` needs `node_modules` present, which section 9 has already
  moved by hand;
- the frontend build is Vite plus TypeScript - it needs nothing from the network
  once the packages are there, but there is no reason to make the server do it;
- building where you can see the output means a failed build is a problem on
  your desk rather than on a production machine.

What to copy to the server:

```
backend/dist/          the compiled API
shared/dist/           the compiled shared package (backend imports it at runtime)
frontend/dist/         the built SPA - whatever serves it (section 7)
node_modules/          all of them, per section 9
package.json, backend/package.json, shared/package.json
backend/.env           written on the server, never copied from a laptop
backend/*.traineddata  if TESSERACT_LANG_PATH points inside the repo
```

`shared/dist` matters: `backend/tsconfig.json` deliberately has no path mapping,
so the compiled backend imports `@asps-dms/shared` and resolves it through the
workspace symlink to `shared/dist`. A backend copied without it starts and then
fails on the first request.

Migrations and seeds run **from the repository on the server** (they read
`database/migrations/*.sql` off disk), so copy `database/` too - or run
`db:migrate` from a machine that can reach SQL Server.

---

## Order to do it in

1. Build on the laptop: `npm ci`, `npm run verify`, `npm run build`.
2. Copy the tree to the server (section 10).
3. Write `backend/.env` (section 8).
4. `npm run db:check` - proves the connection and prints the SQL Server
   version, edition and compatibility level.
5. `npm run db:migrate`, then `npm run db:status` - nothing pending.
6. `npm run db:seed` - roles, ten document types, departments and designations.
7. `npm run user:add` five times.
8. Decide section 7 and serve `frontend/dist`.
9. Start `node backend/dist/server.js` as a service, working directory
   `backend/`.
10. `GET /api/health/ready` - it reports the database and the document store.

## Still open

- **No employee import** (section 4).
- **Nothing serves the frontend** (section 7).
- Two `.traineddata` files at the repository root are untracked (section 2).
