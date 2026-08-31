import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

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
    // Applied before any module loads, so config/env.ts validates against it.
    setupFiles: ['./tests/setup/test-env.ts'],
    reporters: 'default',
  },
})
