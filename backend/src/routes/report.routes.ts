import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import { requirePermission } from '../middleware/requireAuth.js'
import * as reportController from '../controllers/report.controller.js'

export const reportRouter: Router = Router()

reportRouter.get(
  '/by-document-type',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.byDocumentType,
)

reportRouter.get(
  '/outstanding',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.outstanding,
)

reportRouter.get('/exits', requirePermission(PERMISSIONS.REPORT_READ), reportController.exits)

/* The employees behind one document row. A sub-resource of the report rather
   than a query on the employee list, because what it returns is that row
   expanded - the same predicates, so the two cannot disagree. */
reportRouter.get(
  '/by-document-type/:documentTypeId/employees',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.employeesForDocumentType,
)

/* The same list as a PDF. Its own path rather than a format parameter on the
   one above, so the JSON route keeps returning JSON whatever a caller asks for
   in a query string. */
reportRouter.get(
  '/by-document-type/:documentTypeId/employees/print',
  requirePermission(PERMISSIONS.REPORT_READ),
  reportController.printEmployeesForDocumentType,
)
