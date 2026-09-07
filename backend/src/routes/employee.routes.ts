import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as employeeController from '../controllers/employee.controller.js'
import * as signatureController from '../controllers/signature.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'
import { uploadSingleDocument } from '../middleware/upload.js'

/**
 * /api/employees
 *
 * Mounted with requireAuth and requirePasswordChanged in front of it
 * (routes/index.ts), so every handler here already has a signed-in user; what
 * each route adds is the permission it needs.
 *
 * Order matters: '/facets' is declared before '/:employeeId', or the
 * parameterised route would match 'facets' and reject it as an invalid id.
 */
export const employeeRouter: Router = Router()

employeeRouter.get('/', requirePermission(PERMISSIONS.EMPLOYEE_READ), employeeController.list)

employeeRouter.get(
  '/facets',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  employeeController.facets,
)

/**
 * The printed forms.
 *
 * '/print' is declared beside '/facets', before the parameterised routes, for
 * the reason given above: a literal path under a router that also matches
 * '/:employeeId' has to come first.
 *
 * A POST, and a list of ids in the body rather than in the query string: a
 * hundred ids makes a URL long enough for something in front of the server to
 * truncate, and a truncated selection prints the wrong people rather than
 * failing.
 *
 * EMPLOYEE_READ, so a Viewer can print a checklist. The single-employee route
 * below now prints something else entirely and asks for more.
 */
employeeRouter.post(
  '/print',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  employeeController.printForms,
)

employeeRouter.post('/', requirePermission(PERMISSIONS.EMPLOYEE_CREATE), employeeController.create)

employeeRouter.get(
  '/:employeeId',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  employeeController.getById,
)

employeeRouter.patch(
  '/:employeeId',
  requirePermission(PERMISSIONS.EMPLOYEE_UPDATE),
  employeeController.update,
)

/* Archive and restore are POSTs to a named sub-resource rather than a PATCH of
   IsActive: the client asks for an outcome and the server decides what that
   means. There is deliberately no DELETE - employees are archived, never
   removed (standing assumption 2). */
employeeRouter.post(
  '/:employeeId/archive',
  requirePermission(PERMISSIONS.EMPLOYEE_ARCHIVE),
  employeeController.archive,
)

/**
 * Recording that an employee has left, and undoing it.
 *
 * A sub-resource of its own, and NOT part of archive: leaving the company and
 * the office being finished with the record are different things, and someone
 * who has left is normally not archived at all - their provident fund and
 * gratuity papers have to be produced for years afterwards.
 *
 * DELETE removes the EXIT, never the employee. The dates come off and the
 * status goes back to ACTIVE; both the exit and the undo stay in the audit
 * trail, which is the only place either is permanent.
 */
employeeRouter.post(
  '/:employeeId/exit',
  requirePermission(PERMISSIONS.EMPLOYEE_EXIT),
  employeeController.markLeft,
)

employeeRouter.delete(
  '/:employeeId/exit',
  requirePermission(PERMISSIONS.EMPLOYEE_EXIT),
  employeeController.undoExit,
)

employeeRouter.post(
  '/:employeeId/restore',
  requirePermission(PERMISSIONS.EMPLOYEE_ARCHIVE),
  employeeController.restore,
)

employeeRouter.get(
  '/:employeeId/documents',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  employeeController.listDocuments,
)

/* One employee's file: their details, then the documents themselves.

   DOCUMENT_DOWNLOAD, where the bulk print beside '/facets' still takes
   EMPLOYEE_READ. They print different papers now: that one is a checklist,
   which a Viewer may walk to the printer with; this one hands over the files,
   which a Viewer may read on screen and may not take away.

   Enforced HERE and not only by hiding the button. A URL is a URL. */
employeeRouter.get(
  '/:employeeId/print',
  requirePermission(PERMISSIONS.DOCUMENT_DOWNLOAD),
  employeeController.printForm,
)

/* The signature belongs to the employee, not to any one document: it is
   uploaded once and reused on everything they sign (Section 24). */
/* The photograph. Reading it needs only EMPLOYEE_READ - it is part of the
   record - while replacing it is an edit of the record, so it takes
   EMPLOYEE_UPDATE rather than a permission of its own. */
employeeRouter.post(
  '/:employeeId/photo',
  requirePermission(PERMISSIONS.EMPLOYEE_UPDATE),
  uploadSingleDocument,
  employeeController.uploadPhoto,
)

employeeRouter.get(
  '/:employeeId/photo/image',
  requirePermission(PERMISSIONS.EMPLOYEE_READ),
  employeeController.downloadPhoto,
)

employeeRouter.get(
  '/:employeeId/signature',
  requirePermission(PERMISSIONS.SIGNATURE_READ),
  signatureController.getEmployeeSignature,
)

employeeRouter.post(
  '/:employeeId/signature',
  requirePermission(PERMISSIONS.SIGNATURE_UPLOAD),
  uploadSingleDocument,
  signatureController.uploadEmployeeSignature,
)

employeeRouter.get(
  '/:employeeId/signature/image',
  requirePermission(PERMISSIONS.SIGNATURE_READ),
  signatureController.downloadEmployeeSignature,
)
