import type { AuthUser } from '@asps-dms/shared'
import { logger } from '../utils/logger.js'
import type { RequestContext } from './auth.service.js'

/**
 * The employee's documents still waiting for a signature are decided about
 * again, now that an image has arrived - after the save has been answered,
 * and never able to fail it. The runner is imported at the call: it reaches
 * signature.service, which reaches employee.service, and both of those call
 * this - a static cycle is a thing to avoid even where the runtime would
 * tolerate it.
 */
export function redecideInBackground(
  employeeId: number,
  actor: AuthUser,
  context: RequestContext,
  trigger: 'signature saved' | 'photo saved',
): void {
  void import('./autoStampRun.service.js')
    .then((runner) => runner.redecideForEmployee(employeeId, actor, context, trigger))
    .catch((error) => {
      logger.error({ err: error, employeeId, trigger }, 'Deciding again after a save threw')
    })
}
