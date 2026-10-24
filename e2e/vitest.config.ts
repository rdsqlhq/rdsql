import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// End-to-end suites that need real database servers (see e2e/backup/README.md).
// Kept out of the default `npm test` run, which has no servers to talk to.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, '..'),
  test: {
    environment: 'jsdom',
    include: ['e2e/**/*.e2e.test.tsx'],
    setupFiles: ['e2e/backup/setup.ts'],
    globals: true,
    // Each test backs up and verifies ~450k rows; run files one at a time
    // so they don't compete for the same servers.
    fileParallelism: false,
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
