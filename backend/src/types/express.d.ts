/**
 * Express request augmentation.
 *
 * Kept to the few values the whole request pipeline needs. `requestId` is set
 * by the requestId middleware before anything else runs, so it is non-optional;
 * `user` and `session` are filled in by the authentication middleware and are
 * therefore optional until then.
 */
import type { AuthUser } from '@asps-dms/shared'

declare global {
  namespace Express {
    interface Request {
      /** Correlates a log entry with the referenceId shown to the user. */
      requestId: string
      /** Present only after requireAuth has run. */
      user?: AuthUser
      /** dbo.Sessions.SessionId for the current request, if authenticated. */
      sessionId?: number
    }
  }
}

export {}
