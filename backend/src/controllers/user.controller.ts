import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import { createUserSchema, idParamSchema, updateUserSchema, type AuthUser } from '@asps-dms/shared'
import { requestContext } from '../services/audit.service.js'
import * as userService from '../services/user.service.js'
import { UnauthenticatedError } from '../utils/errors.js'
import { parseBody, parseParams } from '../utils/validation.js'

/**
 * The Users screen's endpoints, all under user:manage.
 *
 * Thin on purpose: the rules - no self-deactivation, the last administrator
 * stays, passwords never seen - live in user.service.ts.
 */

const userParamsSchema = z.object({ userId: idParamSchema })

function actorOf(req: Request): AuthUser {
  if (!req.user) throw new UnauthenticatedError()
  return req.user
}

export const list: RequestHandler = async (_req, res) => {
  res.json({ users: await userService.list() })
}

/** 201 with the account and, once, its temporary password. */
export const create: RequestHandler = async (req, res) => {
  const input = parseBody(req, createUserSchema)
  const created = await userService.create(input, actorOf(req), requestContext(req))
  res.status(201).json(created)
}

export const resetPassword: RequestHandler = async (req, res) => {
  const { userId } = parseParams(req, userParamsSchema)
  res.json(await userService.resetPassword(userId, actorOf(req), requestContext(req)))
}

export const update: RequestHandler = async (req, res) => {
  const { userId } = parseParams(req, userParamsSchema)
  const input = parseBody(req, updateUserSchema)
  res.json({ user: await userService.update(userId, input, actorOf(req), requestContext(req)) })
}
