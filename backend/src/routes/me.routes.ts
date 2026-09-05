import { Router } from 'express'
import { PERMISSIONS } from '@asps-dms/shared'
import * as signatureController from '../controllers/signature.controller.js'
import { requirePermission } from '../middleware/requireAuth.js'
import { uploadSingleDocument } from '../middleware/upload.js'

/**
 * Things that belong to the signed-in user rather than to a record.
 *
 * There is no user id anywhere in these paths, deliberately: the authorising
 * signature is the mark that says who signed a document off, so there must be
 * no request by which one person can set another's. /me is what guarantees
 * that, rather than a check inside each handler remembering to compare ids.
 *
 * SIGNATURE_UPLOAD gates it because only someone who can sign documents has any
 * use for a signature: a Viewer never authorises anything.
 */
export const meRouter: Router = Router()

meRouter.get(
  '/signature',
  requirePermission(PERMISSIONS.SIGNATURE_UPLOAD),
  signatureController.getMySignature,
)

meRouter.post(
  '/signature',
  requirePermission(PERMISSIONS.SIGNATURE_UPLOAD),
  uploadSingleDocument,
  signatureController.saveMySignature,
)

meRouter.get(
  '/signature/image',
  requirePermission(PERMISSIONS.SIGNATURE_UPLOAD),
  signatureController.downloadMySignature,
)
