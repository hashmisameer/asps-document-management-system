import type { RequestHandler } from 'express'
import * as referenceRepository from '../repositories/reference.repository.js'

/** The lists the employee form offers. Read-only, and read by every role. */
export const list: RequestHandler = async (_req, res) => {
  res.json({ reference: await referenceRepository.listReference() })
}
