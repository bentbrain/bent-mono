import { defineConfig } from '@playwright/test';
import { fullOnlyPattern } from './tests/fixtures/browser-coverage.ts';

const tier = process.env.E2E_TIER || 'critical';
if (!['critical', 'full'].includes(tier))
  throw new Error('E2E_TIER must be critical or full');
export default defineConfig({
  testDir: 'tests/browser',
  forbidOnly: true,
  grepInvert: tier === 'full' ? undefined : fullOnlyPattern,
  reporter: [['list'], ['./tests/fixtures/browser-reporter.ts']],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4391',
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'bun run dev --host 127.0.0.1 --port 4391 --ignore-lock',
    url: 'http://127.0.0.1:4391/_emdash/api/health',
    reuseExistingServer: false,
    env: {
      TEST_EPHEMERAL: '1',
      PUBLIC_FEEDBACK_SERVER: 'https://toolbar.bent.build',
      PUBLIC_FEEDBACK_PROJECT_ID: 'prj_0000000000000000',
    },
    timeout: 60_000,
  },
});
