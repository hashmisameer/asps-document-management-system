import type { Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import {
  idParamSchema,
  overrideIdentityCheckSchema,
  previewIdentitySchema,
  rejectDocumentSchema,
  updateDeadlineSchema,
  uploadDocumentSchema,
  type AuthUser,
  documentListQuerySchema,
} from '@asps-dms/shared'
import * as documentService from '../services/document.service.js'
import { checkNameOnly } from '../services/documentVerification.service.js'
import { inspectDocumentUpload } from '../services/fileValidation.service.js'
import { requestContext } from '../services/audit.service.js'
import { BadRequestError, UnauthenticatedError } from '../utils/errors.js'
import { parseBody, parseParams, parseQuery } from '../utils/validation.js'

/**
 * Document endpoints.
 *
 * The two file-serving routes are the only place in this API where the response
 * is not JSON, and they are still ordinary authenticated, authorised routes:
 * there is no signed URL, no token in a query string, and nothing readable
 * without a session.
 */

const documentParamsSchema = z.object({ documentId: idParamSchema })

function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

export const getById: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  res.json({ document: await documentService.getById(documentId) })
}

export const upload: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)

  if (!req.file) {
    throw new BadRequestError("Attach the document in a form field named 'file'.")
  }

  // The metadata travels as text fields beside the file, so it is validated
  // with the same schema a JSON body would have been.
  const input = parseBody(req, uploadDocumentSchema)

  const document = await documentService.uploadFile(
    documentId,
    req.file,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}

export const verify: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const document = await documentService.verify(documentId, actorOf(req), requestContext(req))
  res.json({ document })
}

export const reject: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const { reason } = parseBody(req, rejectDocumentSchema)
  const document = await documentService.reject(
    documentId,
    reason,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}

export const updateDeadline: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const input = parseBody(req, updateDeadlineSchema)
  const document = await documentService.updateDeadline(
    documentId,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}

/**
 * Streams the file.
 *
 * `inline` asks the browser to display it and `attachment` to save it, which is
 * the whole difference between preview and download - and the reason they are
 * separate permissions (open question Q6: a Viewer may preview, not download).
 *
 * The stream is piped rather than read into memory: a 25 MB PDF held per
 * concurrent viewer is memory this server has no reason to spend.
 */
function sendFile(res: Response, delivery: documentService.DocumentDelivery, disposition: string) {
  res.setHeader('Content-Type', delivery.mimeType)
  res.setHeader('Content-Disposition', contentDisposition(disposition, delivery.fileName))
  // The file is personal data behind a session; no shared cache may keep it.
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  delivery.stream.pipe(res)
}

/**
 * Content-Disposition with both spellings of the name.
 *
 * `filename` is ASCII-only by the specification, so a name with an accent has
 * to travel in `filename*` as well; a browser that understands the second
 * prefers it, and one that does not still gets something sensible.
 */
function contentDisposition(disposition: string, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export const preview: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const delivery = await documentService.openForDelivery(
    documentId,
    'preview',
    actorOf(req),
    requestContext(req),
  )
  sendFile(res, delivery, 'inline')
}

export const download: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const delivery = await documentService.openForDelivery(
    documentId,
    'download',
    actorOf(req),
    requestContext(req),
  )
  sendFile(res, delivery, 'attachment')
}

/**
 * Removes the file from a document, returning the row to Pending.
 *
 * DELETE on the file rather than on the document: the checklist row itself is
 * not being deleted - it is still expected of this employee, and still has its
 * deadline.
 */
export const removeFile: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const document = await documentService.removeFile(documentId, actorOf(req), requestContext(req))
  res.json({ document })
}

/** Accepts a document the identity check refused, in the actor's own name. */
export const overrideIdentityCheck: RequestHandler = async (req, res) => {
  const documentId = parseParams(req, documentParamsSchema).documentId
  const { reason } = parseBody(req, overrideIdentityCheckSchema)
  const document = await documentService.overrideIdentityCheck(
    documentId,
    reason,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}

/**
 * Checks a file against a typed name, before any employee record exists.
 *
 * The Add Employee screen collects the Aadhaar and PAN cards before there is
 * anything to attach them to, so they were the only documents in the system
 * nobody checked - attached on trust, and read only after the employee had been
 * created around them.
 *
 * Nothing is stored and nothing is written. The file is read, compared and
 * forgotten; the answer is for the screen to act on.
 */
export const previewIdentity: RequestHandler = async (req, res) => {
  if (!req.file) {
    throw new BadRequestError("Attach the document in a form field named 'file'.")
  }

  const { employeeName, documentName } = parseBody(req, previewIdentitySchema)
  const inspected = await inspectDocumentUpload(req.file)

  const result = await checkNameOnly(
    { buffer: req.file.buffer, mimeType: inspected.mimeType },
    employeeName,
    documentName,
  )

  res.json(result)
}

/**
 * Every checklist row in the company, filtered and paged.
 *
 * DOCUMENT_READ, which a Viewer has: this is the list the dashboard's document
 * tiles open, and reading a tile and reading the list behind it are the same
 * act. Nothing here changes anything.
 */
export const list: RequestHandler = async (req, res) => {
  const query = parseQuery(req, documentListQuerySchema)
  res.json(await documentService.list(query))
}