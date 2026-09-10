import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as documentController from '../controllers/document.controller.js'
import * as signatureController from '../controllers/signature.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'
import { uploadSingleDocument } from '../middleware/upload.js'

/**
 * /api/documents
 *
 * A document row exists from the moment the employee does - the checklist is
 * materialised with them - so there is no route that creates one, and none that
 * deletes one. What changes is the file attached to it and its status.
 *
 * Uploading and REPLACING are separate permissions. The route asks for
 * DOCUMENT_UPLOAD; the service additionally requires DOCUMENT_REPLACE when
 * there is already a file there, because only the row knows which this is.
 */
export const documentRouter: Router = Router()

/* The whole checklist across every employee, filtered - what the dashboard's
   document tiles open. Declared before '/:documentId' so the bare path is a
   list rather than an id that fails to parse. */
documentRouter.get('/', requirePermission(PERMISSIONS.DOCUMENT_READ), documentController.list)

documentRouter.get(
  '/:documentId',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  documentController.getById,
)

documentRouter.post(
  '/:documentId/file',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  uploadSingleDocument,
  documentController.upload,
)

/* Checking a file before there is a document row to put it in. Not addressed by
   document id, because on the Add Employee screen there is not one yet. */
documentRouter.post(
  '/identity-preview',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  uploadSingleDocument,
  documentController.previewIdentity,
)

/* Removing the FILE, not the checklist row: the document is still expected of
   this employee and keeps its deadline. Gated on DOCUMENT_REPLACE - taking a
   file off is replacing it with nothing. */
documentRouter.delete(
  '/:documentId/file',
  requirePermission(PERMISSIONS.DOCUMENT_REPLACE),
  documentController.removeFile,
)

documentRouter.post(
  '/:documentId/verify',
  requirePermission(PERMISSIONS.DOCUMENT_VERIFY),
  documentController.verify,
)

/* Accepting a refused document. DOCUMENT_UPLOAD rather than a permission of its
   own: whoever may put the document there is who decides it is the right one. */
documentRouter.post(
  '/:documentId/identity-override',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  documentController.overrideIdentityCheck,
)

/* Not required of THIS employee - and the undoing of it.

   DEADLINE_UPDATE, which HR and Admin hold and a Viewer does not. This is the
   same shape of decision as moving a deadline: it changes what the employee is
   asked for, rather than recording something they produced. */
documentRouter.patch(
  '/:documentId/not-required',
  requirePermission(PERMISSIONS.DEADLINE_UPDATE),
  documentController.setNotRequired,
)

documentRouter.post(
  '/:documentId/reject',
  requirePermission(PERMISSIONS.DOCUMENT_REJECT),
  documentController.reject,
)

documentRouter.patch(
  '/:documentId/deadline',
  requirePermission(PERMISSIONS.DEADLINE_UPDATE),
  documentController.updateDeadline,
)

/* Preview and download are deliberately different permissions: Section 6 gives
   a Viewer preview without download, and the two headers - inline against
   attachment - are the only difference in what is served. */
documentRouter.get(
  '/:documentId/preview',
  requirePermission(PERMISSIONS.DOCUMENT_PREVIEW),
  documentController.preview,
)

documentRouter.get(
  '/:documentId/download',
  requirePermission(PERMISSIONS.DOCUMENT_DOWNLOAD),
  documentController.download,
)

/* Placements are per document: where this employee's signature goes on this
   file. Saving them regenerates the signed copy from the ORIGINAL, which is
   why it is a PUT of the complete set rather than a PATCH of one. */
documentRouter.get(
  '/:documentId/placements',
  requirePermission(PERMISSIONS.SIGNATURE_READ),
  signatureController.listPlacements,
)

documentRouter.put(
  '/:documentId/placements',
  requirePermission(PERMISSIONS.SIGNATURE_PLACE),
  signatureController.savePlacements,
)

documentRouter.post(
  '/:documentId/skip-signature',
  requirePermission(PERMISSIONS.SIGNATURE_SKIP),
  signatureController.skipSignature,
)
