import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The integration run: the same code, against a real SQL Server.
 *
 * Separate from vitest.config.ts because the two need opposite things from the
 * environment. The unit run points at a host that does not resolve, so nothing
 * can reach a database by accident; this one needs a real connection, and
 * forces the database name to ASPS_DMS_TEST so it can delete rows freely.
 *
 * Single-threaded and non-parallel on purpose. These tests share one database
 * and reset it between files; running them at once would have them clearing
 * each other's rows, and the failures would look like application bugs.
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
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup/integration-env.ts'],
    globalSetup: ['./tests/setup/integration-global.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // Migrations, scrypt hashing and PDF work are all real here, so the
    // default five seconds is not enough.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: 'default',
  },
})
