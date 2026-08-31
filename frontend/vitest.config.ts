import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Frontend unit tests.
 *
 * Node environment, not jsdom: what is tested here is the logic that decides
 * what the user is told and what they are shown - error mapping and the
 * permission-driven navigation - none of which needs a DOM. Component
 * rendering tests would need jsdom and Testing Library; they are not here yet.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@asps-dms/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
  },
})
