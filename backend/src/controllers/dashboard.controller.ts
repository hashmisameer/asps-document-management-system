import type { RequestHandler } from 'express'
import { DEFAULT_DUE_SOON_THRESHOLD_DAYS } from '@asps-dms/shared'
import * as dashboardRepository from '../repositories/dashboard.repository.js'

/**
 * The dashboard summary.
 *
 * Read-only and cheap, and gated on REPORT_READ so a Viewer - who is
 * management, and the person most likely to want the headline numbers - can see
 * it without being able to change anything.
 */
export const summary: RequestHandler = async (_req, res) => {
  res.json({ summary: await dashboardRepository.getSummary(DEFAULT_DUE_SOON_THRESHOLD_DAYS) })
}
