# API reference

Every endpoint, the permission it requires, and a body to send it.

Base URL in development: `http://127.0.0.1:4000/api`

All routes except `/health`, `/health/ready` and `/auth/login` require a signed-in
session. The session is an **httpOnly cookie** set by `/auth/login`, so a client
only has to keep cookies - there is no bearer token and nothing to put in a
header.

> **Local development only.** The accounts at the bottom of this file exist on a
> developer laptop against `.\SQLEXPRESS`. They are not production credentials
> and must never be created on the company server, where accounts are made with
> `npm run db:create-user`, which prints a one-time password.

---

## Before anything works: two gates

**1. Sign in and keep the cookie.**

```bash
curl -c jar.txt -X POST http://127.0.0.1:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"test.hr","password":"HrTest2026pass"}'
```

Then send `-b jar.txt` on every later request.

**2. `MustChangePassword` blocks everything else.**

A brand-new account gets **403 `PASSWORD_CHANGE_REQUIRED`** on every data route
until it sets a password, whatever its role. `npm run db:create-user` always sets
that flag, even when it was given a password. The three `test.*` accounts below
have already been through it and are ready to use.

---

## Roles

Permissions are what the server actually checks; roles are bundles of them.

| Role | In short |
|---|---|
| `ADMIN` | Everything HR can do, plus `user:manage`. |
| `HR` | Full employee, document, deadline and signature workflow, plus reports, audit and settings. |
| `VIEWER` | Management. Sees, downloads and prints everything - employees, documents, signatures, document types, reports, the employee file - and changes nothing (decided 2026-09-19, Q6). |

A request whose role lacks the permission gets **403 `FORBIDDEN`**.

---

## Health

| Method | URL | Access | Notes |
|---|---|---|---|
| GET | `/health` | Public | Always 200 while the process is up. |
| GET | `/health/ready` | Public | 200 only when SQL Server is reachable; **503** otherwise. |

---

## Authentication

| Method | URL | Access |
|---|---|---|
| POST | `/auth/login` | Public (rate limited) |
| POST | `/auth/logout` | Any signed-in user |
| GET | `/auth/me` | Any signed-in user |
| POST | `/auth/change-password` | Any signed-in user |

```jsonc
// POST /auth/login
{ "username": "test.hr", "password": "HrTest2026pass" }

// POST /auth/change-password  - confirmPassword is REQUIRED
{
  "currentPassword": "HrTest2026pass",
  "newPassword": "NewPassword2026",
  "confirmPassword": "NewPassword2026"
}
```

Password policy: at least 12 characters, with a lowercase letter, an uppercase
letter and a digit. Changing a password **ends every other session** for that
user.

A wrong password and an unknown username give the **same** answer, deliberately,
so the endpoint cannot be used to find out which usernames exist.

---

## Employees

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/employees` | `employee:read` | Admin, HR, Viewer |
| GET | `/employees/facets` | `employee:read` | Admin, HR, Viewer |
| POST | `/employees` | `employee:create` | Admin, HR |
| GET | `/employees/:employeeId` | `employee:read` | Admin, HR, Viewer |
| PATCH | `/employees/:employeeId` | `employee:update` | Admin, HR |
| POST | `/employees/:employeeId/archive` | `employee:archive` | Admin, HR |
| POST | `/employees/:employeeId/restore` | `employee:archive` | Admin, HR |
| GET | `/employees/:employeeId/documents` | `document:read` | Admin, HR, Viewer |

`GET /employees` takes `page`, `pageSize`, `search`, `department`,
`designation`, `isActive`, `sortBy` and `sortOrder` as query parameters.

```jsonc
// POST /employees
// The employee code is ASSIGNED BY THE SERVER (EMP001, EMP002, ...) and is
// immutable. Do not send one - and note that a document naming a different
// code will be refused by the identity check.
{
  "employeeName": "Ravi Kumar",
  "joiningDate": "2026-04-01",
  "department": "Accounts",
  "designation": "Accounts Officer",
  "phoneNumber": "9876543210",
  "dateOfBirth": "1990-08-15",
  "aadhaarNumber": "123456789012",
  // asps-dms:allow-secret - the documented placeholder PAN, not anyone's.
  "panNumber": "ABCDE1234F"
}

// PATCH /employees/:employeeId  - any subset of the same fields
{ "designation": "Senior Accounts Officer" }
```

There is **no DELETE**. Archiving is the only removal.

### Who may add whom, by joining date

The joining date decides whether the caller may create the record at all. The
same rule applies to `POST /employees`, to the bulk import, and to a `PATCH`
that *changes* the joining date (sending it back unchanged is never judged):

| Joining date | HR | Admin |
|---|---|---|
| Today, or one of the `JOINING_DATE_WINDOW_DAYS - 1` days before it | allowed | allowed |
| Earlier than that | **refused** | allowed |
| In the future | **refused** | **refused** |

`JOINING_DATE_WINDOW_DAYS` is a server setting, default 7 - today and the six
days before it. On 18 September HR may use 12-18 September; 11 September is
refused. "Today" is the server's own date, the same one the deadlines use.

A refusal is a `400 VALIDATION_FAILED` with one issue on the `joiningDate`
field, so the form can show it under the date:

```jsonc
{ "path": "joiningDate",
  "message": "This joining date is more than 7 days old. Only an administrator can add this employee." }

{ "path": "joiningDate", "message": "The joining date cannot be in the future." }
```

In the bulk import a row that breaks the rule is listed under "cannot be
created" with the same sentence, and the other rows still import. The
signed-in user's `joiningDateWindowDays` is included on `GET /auth/me` and the
login response, so a form can warn before the server refuses.

---

## Document types

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/document-types` | `documentType:read` | Admin, HR, Viewer |

Read-only until the Settings screen exists. Ten types are seeded; each carries
`requiredFields`, which is what the identity check compares against.

---

## Documents

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/documents/:documentId` | `document:read` | Admin, HR, Viewer |
| POST | `/documents/:documentId/file` | `document:upload` | Admin, HR |
| POST | `/documents/:documentId/verify` | `document:verify` | Admin, HR |
| POST | `/documents/:documentId/reject` | `document:reject` | Admin, HR |
| PATCH | `/documents/:documentId/deadline` | `deadline:update` | Admin, HR |
| GET | `/documents/:documentId/preview` | `document:preview` | Admin, HR, Viewer |
| GET | `/documents/:documentId/download` | `document:download` | Admin, HR, Viewer |

Documents are **not created** by the API. Creating an employee materialises one
checklist row per active document type; you upload a file onto an existing row.
Get the ids from `GET /employees/:employeeId/documents`.

### Uploading a file

`multipart/form-data`, with the file in a field named **`file`**.

| Field | Required | Notes |
|---|---|---|
| `file` | yes | PDF, JPG or PNG. Sniffed by content, not by extension. |
| `isExistingRecord` | no | `true` backdates a document already on paper. |
| `landingStatus` | no | `Uploaded` (default) or `Verified`. |
| `notes` | no | Up to 500 characters. |
| `identityOverrideReason` | only to override | At least 10 characters. See below. |

```bash
curl -b jar.txt -X POST http://127.0.0.1:4000/api/documents/21/file \
  -F 'file=@appointment.pdf;type=application/pdf' \
  -F 'isExistingRecord=false'
```

Replacing a file that is already there additionally requires
`document:replace`, and **voids any signature work** on the document.

### The identity check, and how to get past it

The file is read - the PDF's own text layer, or OCR for a scan - and compared
with the employee's record. A document that does not confirm the details its
type asks for is **refused with 422 `IDENTITY_CHECK_FAILED`**, and nothing is
stored.

```jsonc
// 422 response. `details.checks` says which field failed and why.
{
  "error": {
    "code": "IDENTITY_CHECK_FAILED",
    "message": "This document does not mention the employee's employee code, ...",
    "details": {
      "source": "PdfText",
      "unreadable": false,
      "checks": [
        { "field": "EmployeeName", "result": "Matched",  "expected": "Ravi Kumar" },
        { "field": "EmployeeCode", "result": "NotFound", "expected": "EMP002" }
      ]
    }
  }
}
```

Send the same file again with a reason to accept it anyway:

```bash
curl -b jar.txt -X POST http://127.0.0.1:4000/api/documents/21/file \
  -F 'file=@appointment.pdf;type=application/pdf' \
  -F 'identityOverrideReason=The scan is too faint for the Aadhaar number to be read'
```

`expected` is **null** for Aadhaar, PAN, UAN and ESI numbers - the API never
echoes an identity number back.

To test the *passing* path, put the employee's name, server-assigned code and
joining date in the PDF's text. To test the refusal, change any one of them.
Set `IDENTITY_CHECK_ENABLED=false` in `backend/.env` to switch the whole check
off; the document is then recorded as `NotChecked`.

### Stamping on upload

A document that needs a signature is uploaded in `PendingDetection` ("Detecting")
and leaves it a few seconds later, after the identity check has settled. If
the type has a template and the file matches one of its forms, the boxes are
stamped - the employee's enrolled signature, the uploader's own `/me/signature`
in the HR box, the employee's photograph on the ESIC form - and the document
becomes `Added`. Any box left alone (something already in it, an image not on
file, no matching template, a JPG or PNG scan, a failed identity check) sends
the document to `ReviewRequired` with the decision on the row. The checklist
shows only whether it was stamped - 'Stamped automatically', 'Partly stamped',
'Not stamped', and nothing at all in report mode; the reasons stay in the
decision row and the report:

```jsonc
// GET /documents/:documentId  - the latest decision travels with the document
"stampDecision": {
  "mode": "Stamp",                 // Report | Stamp - the server's AUTO_STAMP at the time
  "outcome": "Partial",            // Stamped | Partial | Nothing | NotInList | NoTemplate | NoVariant |
                                   // AmbiguousVariant | NotPdf | Unreadable | IdentityFailed | Failed
  "summary": "Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.",
  "stampedCount": 1,
  "skippedCount": 1,
  "boxes": [
    // action: stamp | skip | keep - 'keep' is a placement already on the
    // document for that role and page, kept as it is when the rest went on
    { "signerRole": "Employee",   "pageNumber": 1, "action": "stamp", "reason": null, "found": "empty" },
    { "signerRole": "Authoriser", "pageNumber": 1, "action": "skip",
      "reason": "the person who uploaded it has no signature on file", "found": "empty" }
  ],
  "decidedAt": "2026-09-18T04:11:00.000Z"
}
```

`stampDecision` is `null` for a document uploaded before this existed or
whose type needs no signature. With `AUTO_STAMP=report` (the default) the
decision is recorded, `mode` is `Report`, nothing is stamped, and the document
goes to `ReviewRequired` whatever the outcome says - the outcome is what
*would* have happened. Placements stamped this way carry
`detectionMethod: "Template"`; the audit trail records `AUTO_STAMP_DECIDED`
for every decision and `SIGNATURE_PLACED_FROM_TEMPLATE` when boxes went on.
There is no endpoint to trigger or approve it; `npm run auto-stamp` reports
and works the backlog (see the deployment notes).

Only the document types in the server's `AUTO_STAMP_TYPES` are candidates
(`ESIC_FORM` today - MMC prints the signatures on every other form itself).
Any other type is decided `NotInList` - recorded once, nothing read, not a
failure - and goes to `ReviewRequired`; the checklist shows nothing for it.
`npm run unstamp` takes the application's stamp off a document that was
signed outside it, through the same code the editor's empty save uses, and
leaves it `Skipped` (deployment notes).

Saving an employee's signature (`POST /employees/:id/signature`) or
photograph (`POST /employees/:id/photo`) decides again about that employee's
documents still waiting for a signature, after the response and never
failing it: in stamp mode, for the listed types, keeping every placement
already on the document and adding only the roles missing from a page.

### Other document bodies

```jsonc
// POST /documents/:documentId/reject   - a reason is required
{ "reason": "The scan is cut off at the bottom" }

// PATCH /documents/:documentId/deadline  - null clears the deadline
{ "dueDate": "2026-09-30", "reason": "Agreed with the employee" }

// POST /documents/:documentId/verify   - no body
```

Status changes go through a state machine. One it does not allow is **409
`INVALID_STATE_TRANSITION`**, not a silent write.

---

## Users

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/users` | `user:manage` | Admin |
| POST | `/users` | `user:manage` | Admin |
| PATCH | `/users/:userId` | `user:manage` | Admin |
| POST | `/users/:userId/reset-password` | `user:manage` | Admin |

The Users screen. **There is no DELETE**: a user is deactivated, never
removed, because documents were signed in their name and the audit trail
carries it. **Passwords are never seen or set by an administrator**: creating
and resetting both generate a temporary password, return it **once** as
`temporaryPassword`, and set `mustChangePassword`, so the person changes it at
their next sign-in. There is no self-service "forgot password"; the
administrator resets it for whoever asks.

```jsonc
// GET /users  - no password material, ever
{ "users": [ {
  "userId": 3, "username": "hr1", "fullName": "Priya Sharma", "role": "HR",
  "isActive": true,
  "mustChangePassword": false,      // true = given an account, never signed in
  "lastLoginAt": "2026-09-18T04:11:00.000Z",
  "hasSignature": false             // no authorising signature: their uploads come out partly stamped
} ] }

// POST /users  -> 201 { user, temporaryPassword }
{ "username": "new.hr", "fullName": "New Person", "role": "HR" }

// PATCH /users/:userId  - any of fullName, role, isActive. Username is immutable.
{ "role": "ADMIN" }
{ "isActive": false }               // ends every session the account has

// POST /users/:userId/reset-password  -> 200 { temporaryPassword }; ends every session
```

Two refusals answer **409 `CONFLICT`** with the reason: you cannot deactivate
or demote your own account, and the last active administrator cannot be
deactivated or moved off `ADMIN`. Every change is audited: `USER_CREATED`,
`USER_PASSWORD_RESET`, `USER_DEACTIVATED`, `USER_REACTIVATED`, `USER_UPDATED`
(with `changes: { role: { from, to } }`). Making somebody an administrator
also lets them add an employee with any past joining date; the role dialog
says so.

---

## Placement templates

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/document-types/placements` | `template:manage` | Admin |
| GET | `/document-types/:documentTypeId/placements` | `template:manage` | Admin |
| PUT | `/document-types/:documentTypeId/placements` | `template:manage` | Admin |
| GET | `/document-types/:documentTypeId/shapes` | `template:manage` | Admin |

A template says where the boxes go on every document of a type, as fractions
of the page (`x`, `y`, `width`, `height` from 0 to 1), drawn on one real
sample. A type holds one template per **shape**: the page count, exactly,
plus which way up the first page is and its proportions to one per cent.
Size does not come into it - 595x842, 595x841 and 596x842 are one shape
(A4 portrait) and one template; Letter (612x792, 1.294 to 1) is another;
a two-page form is another again. A save on a sample replaces the template
of the same shape, whatever exact size that template was drawn on.

```jsonc
// GET /document-types/:documentTypeId/shapes  - the type's stored PDFs, measured
{
  "shapes": {
    "documentTypeId": 1,
    "measured": 121,           // stored PDFs that could be opened
    "unmeasured": 2,           // scans, or files that would not open
    "groups": [                // largest first; a group is what one template covers
      {
        "variant": { "pageCount": 1, "widthPt": 595, "heightPt": 842 },
        "label": "A4 portrait, 1 page",
        "documents": 118, "percent": 98,
        "sizes": ["595x842 (110)", "596x842 (8)"],
        "hasTemplate": true,
        "documentIds": [12, 15, 19, "..."]
      },
      { "variant": { "pageCount": 1, "widthPt": 612, "heightPt": 792 },
        "label": "Letter portrait, 1 page", "documents": 3, "percent": 2,
        "sizes": ["612x792 (3)"], "hasTemplate": false, "documentIds": [88, 91, 97] }
    ]
  }
}
```

The first call for a type opens every stored PDF once and can take a few
seconds; the answer is kept until the type's files change. It is what the
template editor shows beside a sample, and what `npm run stamp-check --
--shapes` prints for every type.

---

## Signatures

| Method | URL | Permission | Roles |
|---|---|---|---|
| GET | `/me/signature` | `signature:upload` | Admin, HR |
| POST | `/me/signature` | `signature:upload` | Admin, HR |
| GET | `/me/signature/image` | `signature:upload` | Admin, HR |
| GET | `/employees/:employeeId/signature` | `signature:read` | Admin, HR, Viewer |
| POST | `/employees/:employeeId/signature` | `signature:upload` | Admin, HR |
| GET | `/employees/:employeeId/signature/image` | `signature:read` | Admin, HR, Viewer |
| GET | `/documents/:documentId/placements` | `signature:read` | Admin, HR, Viewer |
| PUT | `/documents/:documentId/placements` | `signature:place` | Admin, HR |
| POST | `/documents/:documentId/placements/check` | `signature:place` | Admin, HR |
| POST | `/documents/:documentId/skip-signature` | `signature:skip` | Admin, HR |

Both signature uploads are `multipart/form-data` with the image in a field named
**`file`**. `/me/signature` is the signed-in user's own authorising signature -
there is no route that sets somebody else's.

```bash
curl -b jar.txt -X POST http://127.0.0.1:4000/api/employees/3/signature \
  -F 'file=@signature.png;type=image/png'
```

### Placements

`PUT` replaces the **whole set** and regenerates the signed PDF from the
original. There is no partial update; an empty array removes the signature.

```jsonc
// PUT /documents/:documentId/placements
{
  "placements": [
    {
      "pageNumber": 1,
      "x": 0.10, "y": 0.80, "width": 0.25, "height": 0.08,
      "pageRotation": 0,
      "method": "Manual",
      "detectionMethod": "Manual",
      "signerRole": "Employee",
      "confidence": null
    },
    {
      "pageNumber": 1,
      "x": 0.62, "y": 0.80, "width": 0.25, "height": 0.08,
      "pageRotation": 0,
      "method": "Manual",
      "detectionMethod": "Manual",
      "signerRole": "Authoriser",
      "confidence": null
    }
  ]
}
```

- `x`, `y`, `width`, `height` are **normalized 0..1** in displayed page space
  with a top-left origin. Never pixels. See
  [`coordinate-system.md`](coordinate-system.md).
- `pageRotation` must match the page's own `/Rotate`, or the stamper refuses to
  draw rather than putting the signature somewhere else.
- A placement that runs off the page is **rejected** (400
  `VALIDATION_FAILED`), never silently clamped.
- `signerRole` is `Employee` or `Authoriser`. An `Authoriser` box is always
  stamped with the signature of **the user making the request** - the body
  cannot name someone else, so nobody can sign a document off in a colleague's
  name.
- Both signers must have a signature on file, or there is nothing to stamp.

#### Is the box already taken?

Nothing is stamped over something already there. Before the signed copy is
built, every box is checked against the **original** file: on a digital page,
an image covering enough of the box means it is occupied; on a scanned page
(or an image upload) the box's ink is measured against the page's own
background. The thresholds are the `STAMP_*` settings in
[`deployment.md`](deployment.md).

`POST .../placements/check` asks the question without saving. It takes the
same `placements` array as the `PUT` and answers box by box, in request order:

```jsonc
// 200
{
  "occupancy": [
    {
      "index": 0, "signerRole": "Employee", "pageNumber": 1,
      "verdict": "empty",            // empty | occupied | uncertain
      "decidedBy": "none",           // image | ink | none
      "pageKind": "digital",         // digital | scanned
      "overlap": { "images": 0, "coverage": 0 },
      "reason": "no image on the box"
    },
    {
      "index": 1, "signerRole": "Authoriser", "pageNumber": 1,
      "verdict": "occupied",
      "decidedBy": "ink",
      "pageKind": "scanned",
      "overlap": { "images": 0, "coverage": 0 },
      "ink": { "percent": 6.1, "background": 231, "cutoff": 191 },
      "reason": "ink covers 6.1% of the box"
    }
  ]
}
```

The `PUT` runs the same check itself. If any box is `occupied` or `uncertain`
it answers **409 `CONFLICT`** with the boxes in question under
`error.details.occupancy`, and nothing is stamped. Sending the `PUT` again with
`"acknowledgeOccupied": true` stamps anyway; the audit entry then lists which
boxes were acknowledged and what was measured in each.

```jsonc
// POST /documents/:documentId/skip-signature  - reason is optional
{ "reason": "This document does not need signing" }
```

---

## Reminders

There is no reminder endpoint. The daily email is sent by the API itself at
`REPORT_SEND_TIME` to everyone in `REPORT_RECIPIENTS`, and by hand with the
command below. (`POST /reminders/send` existed briefly and was removed on
2026-09-04.)

The email is short: how many employees have how many **overdue** documents,
and that the list is attached. The attachment is an `.xlsx`, named
`asps-dms-overdue-documents-YYYY-MM-DD.xlsx`, with **one row per overdue
document**:

| Column | Cell | Example |
|---|---|---|
| `employee_id` | text, so `00005696` keeps its zeros | `00005696` |
| `employee_name` | text | `Ravi Kumar` |
| `documents_pending` | text | `Appointment Letter` |
| `overdue_dates` | text, `DD/MM/YYYY` like the rest of the app | `11/09/2026` |
| `days of overdue` | number, so Excel sorts it | `7` |

Only overdue documents are in it - not due today, not due this week, not
without a deadline. On a day with nothing overdue no email is sent at all. It
goes out again every day until the files are uploaded.

```bash
npm run send-reminders                 # send
npm run send-reminders -- --dry-run    # print the email and the first 20 rows of the sheet; send nothing
```

---

## Error envelope


Every failure has the same shape:

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the information in the request body is not valid.",
    "details": { "issues": [{ "path": "confirmPassword", "message": "Required" }] }
  }
}
```

| Status | Code | Means |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body or query is wrong. `details.issues` names the fields. |
| 401 | `UNAUTHENTICATED` | No session, or it expired or was revoked. |
| 403 | `FORBIDDEN` | Signed in, but the role lacks the permission. |
| 403 | `PASSWORD_CHANGE_REQUIRED` | The account has not set its password yet. |
| 404 | `NOT_FOUND` | No such record. |
| 409 | `CONFLICT` | Clashes with the current state - a duplicate, say. |
| 409 | `INVALID_STATE_TRANSITION` | The state machine does not allow that change. |
| 413 | `PAYLOAD_TOO_LARGE` | Over `MAX_UPLOAD_MB` (25 by default). |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not a PDF, JPG or PNG by content. |
| 422 | `IDENTITY_CHECK_FAILED` | The document did not confirm the employee. |
| 429 | `RATE_LIMITED` | Too many login attempts. |
| 500 | `INTERNAL_ERROR` | Carries a `referenceId` that matches the server log. |
| 503 | `SERVICE_UNAVAILABLE` | SQL Server is unreachable. |

---

## Test accounts

Created on the local `ASPS_DMS` database and already past the
`MustChangePassword` gate, so they work immediately. One per role, for checking
that permissions are enforced.

<!-- asps-dms:allow-secret - local development accounts on a developer laptop,
     documented so the API can be exercised by hand. Not production credentials:
     the company server's accounts are made with db:create-user, which prints a
     one-time password that must be changed at first sign-in. -->

| Username | Password | Role |
|---|---|---|
| `test.admin` | `AdminTest2026pw` | ADMIN |
| `test.hr` | `HrTest2026pass` | HR |
| `test.viewer` | `ViewerTest2026p` | VIEWER |

`admin` also exists - the first real account - but it is still on its one-time
password and will demand a change at first sign-in, so it is the wrong account
to automate against.

A quick check that the role gate works: `test.viewer` should get **403
`FORBIDDEN`** from `POST /employees`, and **200** from `GET /employees`.

```bash
# Should be 403
curl -b viewer.txt -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:4000/api/employees \
  -H 'Content-Type: application/json' \
  -d '{"employeeName":"Test","joiningDate":"2026-04-01"}'
```

To make more accounts:

```bash
npm run db:create-user -- create-user --username someone \
  --name "Their Name" --role HR --password "InitialPass2026x"
```

Then sign in once and call `/auth/change-password`, or the account stays behind
the `PASSWORD_CHANGE_REQUIRED` gate.
