import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import {
  idParamSchema,
  savePlacementsSchema,
  skipSignatureSchema,
  type AuthUser,
} from '@asps-dms/shared'
import * as signatureService from '../services/signature.service.js'
import { requestContext } from '../services/audit.service.js'
import { BadRequestError, UnauthenticatedError } from '../utils/errors.js'
import { parseBody, parseParams } from '../utils/validation.js'

/**
 * Signature endpoints.
 *
 * Split across two resources because they are two different things: the
 * SIGNATURE belongs to the employee and is uploaded once, while the PLACEMENTS
 * belong to one document and say where that signature goes on it.
 */

const employeeParamsSchema = z.object({ employeeId: idParamSchema })
const documentParamsSchema = z.object({ documentId: idParamSchema })

function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

export const getEmployeeSignature: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  res.json({ signature: await signatureService.getSignatureSummary(employeeId) })
}

export const uploadEmployeeSignature: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)

  if (!req.file) {
    throw new BadRequestError("Attach the signature image in a form field named 'file'.")
  }

  const signature = await signatureService.uploadSignature(
    employeeId,
    req.file,
    actorOf(req),
    requestContext(req),
  )
  res.json({ signature })
}

/**
 * Streams the signature image.
 *
 * `no-store` for the same reason a document is: this is a person's signature,
 * and a copy of it sitting in a shared cache is exactly what must not happen.
 */
export const downloadEmployeeSignature: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const { stream, mimeType } = await signatureService.openSignature(employeeId)

  res.setHeader('Content-Type', mimeType)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  stream.pipe(res)
}

export const listPlacements: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  res.json({ placements: await signatureService.listPlacements(documentId) })
}

/**
 * Replaces a document's placements and regenerates the signed copy.
 *
 * PUT rather than PATCH, because the output is a function of the complete set:
 * the processed PDF is rebuilt from the original against exactly what is sent
 * here, so a partial update would have no coherent meaning.
 */
export const savePlacements: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const input = parseBody(req, savePlacementsSchema)

  const document = await signatureService.savePlacements(
    documentId,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}

export const skipSignature: RequestHandler = async (req, res) => {
  const { documentId } = parseParams(req, documentParamsSchema)
  const { reason } = parseBody(req, skipSignatureSchema)

  const document = await signatureService.skipSignature(
    documentId,
    reason,
    actorOf(req),
    requestContext(req),
  )
  res.json({ document })
}
