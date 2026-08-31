import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './apiError.js'

/**
 * Query defaults.
 *
 * Retrying a 4xx is pointless - the request was wrong, and it will be wrong
 * again - and retrying a 401 is worse, because it turns one expired session
 * into three failed requests before the user is told anything. Only genuine
 * server-side and network failures are retried.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
          return failureCount < 2
        },
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
