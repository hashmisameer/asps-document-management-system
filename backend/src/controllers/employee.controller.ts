import type { Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import {
  createEmployeeSchema,
  employeeListQuerySchema,
  idParamSchema,
  markEmployeeLeftSchema,
  printEmployeeFormsSchema,
  updateEmployeeSchema,
  type AuthUser,
} from '@asps-dms/shared'
import * as employeeService from '../services/employee.service.js'
import { requestContext } from '../services/audit.service.js'
import { BadRequestError, UnauthenticatedError } from '../utils/errors.js'
import { parseBody, parseParams, parseQuery } from '../utils/validation.js'

/**
 * Employee endpoints.
 *
 * Thin on purpose: parse with the shared schema, call the service, return JSON.
 * Every business rule - how a code is generated, what a checklist contains,
 * what archiving means - lives in the service, so there is one place to read it
 * and one place to change it.
 */

const employeeParamsSchema = z.object({ employeeId: idParamSchema })

/**
 * requireAuth runs before every route here, so a missing user means the router
 * was wired wrong. Failing closed is the only safe way to report that.
 */
function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

export const list: RequestHandler = async (req, res) => {
  const query = parseQuery(req, employeeListQuerySchema)
  res.json(await employeeService.list(query))
}

/** The departments and designations in use, for the list page's filters. */
export const facets: RequestHandler = async (_req, res) => {
  res.json(await employeeService.listFacets())
}

export const getById: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  res.json({ employee: await employeeService.getById(employeeId) })
}

export const create: RequestHandler = async (req, res) => {
  const input = parseBody(req, createEmployeeSchema)
  const employee = await employeeService.create(input, actorOf(req), requestContext(req))
  res.status(201).json({ employee })
}

export const update: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const input = parseBody(req, updateEmployeeSchema)
  const employee = await employeeService.update(
    employeeId,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

export const archive: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const employee = await employeeService.setArchived(
    employeeId,
    true,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

export const restore: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const employee = await employeeService.setArchived(
    employeeId,
    false,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

/**
 * Records that an employee has left.
 *
 * A PUT rather than a POST: sending it twice with the same dates leaves the same
 * record, and correcting a date is the same call again with the right one.
 */
export const markLeft: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const input = parseBody(req, markEmployeeLeftSchema)
  const employee = await employeeService.markLeft(
    employeeId,
    input,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

/** Undoes an exit recorded by mistake. The audit trail keeps both halves. */
export const undoExit: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const employee = await employeeService.undoExit(
    employeeId,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

export const listDocuments: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  res.json({ documents: await employeeService.listDocuments(employeeId) })
}

/**
 * Uploads or replaces the employee's photograph.
 *
 * Multipart, in a field named 'file', like every other upload here.
 */
export const uploadPhoto: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  if (!req.file) {
    throw new BadRequestError("Attach the photograph in a form field named 'file'.")
  }
  const employee = await employeeService.uploadPhoto(
    employeeId,
    req.file,
    actorOf(req),
    requestContext(req),
  )
  res.json({ employee })
}

/**
 * Streams the photograph.
 *
 * `no-store`, like a document and a signature: a photograph of a member of
 * staff must not sit in a shared cache.
 */
export const downloadPhoto: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const { stream, mimeType } = await employeeService.openPhoto(employeeId)

  res.setHeader('Content-Type', mimeType)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  stream.pipe(res)
}

/**
 * Sends a generated PDF as a download.
 *
 * `no-store`, like every other personal file this API serves: a form carrying
 * somebody's date of birth and address must not sit in a shared cache. The name
 * is built server-side and is already reduced to plain ASCII, so it needs no
 * RFC 5987 encoding to survive the header.
 */
function sendPdf(res: Response, fileName: string, pdf: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('Content-Length', String(pdf.length))
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(pdf)
}

/**
 * One employee's file: their details, then every document they have sent in.
 *
 * DOCUMENT_READ, not EMPLOYEE_READ. This used to be a checklist, which anybody
 * who could read the record could print; it now carries the documents
 * themselves, so it is gated on being allowed to see them.
 */
export const printForm: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const { fileName, pdf } = await employeeService.printEmployeeFile(
    employeeId,
    actorOf(req),
    requestContext(req),
  )
  sendPdf(res, fileName, pdf)
}

/**
 * Every document this employee has sent in, as one PDF.
 *
 * DOCUMENT_DOWNLOAD, the same permission as taking one document away, because
 * that is what this is - ten of them at once. A Viewer may look at documents
 * and may not download them (Section 6), and a bundle would be the one way
 * round that.
 */
export const downloadDocuments: RequestHandler = async (req, res) => {
  const { employeeId } = parseParams(req, employeeParamsSchema)
  const { fileName, pdf } = await employeeService.bundleDocuments(
    employeeId,
    actorOf(req),
    requestContext(req),
  )
  sendPdf(res, fileName, pdf)
}

/** Several employees' forms, in one PDF, each starting on its own page. */
export const printForms: RequestHandler = async (req, res) => {
  const { employeeIds } = parseBody(req, printEmployeeFormsSchema)
  const { fileName, pdf } = await employeeService.printForms(employeeIds, actorOf(req))
  sendPdf(res, fileName, pdf)
}
