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
| `VIEWER` | Read-only: employees, documents, signatures, document types, reports. **Preview but not download** (open question Q6). |

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
| GET | `/documents/:documentId/download` | `document:download` | Admin, HR |

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

```jsonc
// POST /documents/:documentId/skip-signature  - reason is optional
{ "reason": "This document does not need signing" }
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
