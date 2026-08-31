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
