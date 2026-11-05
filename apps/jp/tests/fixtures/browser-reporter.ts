import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { browserCoverage } from './browser-coverage';

// Do not copy stdout, request URLs, cookies, error bodies, or page content into
// timing artifacts. This suite only uses ephemeral synthetic data.
export default class BrowserReporter implements Reporter {
  private collected = 0;
  private invalid = false;
  private started = Date.now();
  private setupMs = 0;
  private cases: {
    caseId: string | null;
    titlePath: string[];
    status: string;
    expectedStatus: string;
    durationMs: number;
    retry: number;
  }[] = [];
  private measurements: { title: string; durationMs: number }[] = [];

  onBegin(_config: unknown, suite: Suite) {
    const cases = suite.allTests();
    this.setupMs = Date.now() - this.started;
    this.collected = cases.length;
    this.invalid =
      cases.length === 0 ||
      cases.some((item) => item.expectedStatus !== 'passed');
  }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.title.startsWith('measure:'))
      this.measurements.push({ title: step.title, durationMs: step.duration });
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const titlePath = test.titlePath().filter(Boolean);
    const original = browserCoverage.cases.find(
      (entry) => entry.titlePath.join('\0') === titlePath.join('\0'),
    );
    this.invalid ||=
      result.status === 'skipped' ||
      result.status === 'interrupted' ||
      test.expectedStatus !== 'passed';
    this.cases.push({
      caseId: original?.caseId ?? null,
      titlePath,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
      retry: result.retry,
    });
  }
  async onEnd(result: FullResult): Promise<{ status: 'failed' } | undefined> {
    if (process.argv.includes('--list')) return;
    this.invalid ||= this.cases.length !== this.collected;
    const directory = resolve(
      process.env.BROWSER_METRICS_DIR ||
        `artifacts/browser/${process.env.E2E_TIER || 'critical'}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, 'timing.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          commit: process.env.GITHUB_SHA ?? null,
          cachePreparation:
            process.env.BROWSER_CACHE_STATE ??
            (process.env.CI
              ? 'fresh CI checkout'
              : 'uncontrolled local optimizer cache'),
          measurementSpansMayOverlap: true,
          synthetic: true,
          tier: process.env.E2E_TIER || 'critical',
          status: this.invalid ? 'failed' : result.status,
          collected: this.collected,
          collectionAndServerSetupMs: this.setupMs,
          runnerDurationMs: result.duration,
          cases: this.cases,
          measurements: this.measurements,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (this.invalid) {
      process.stderr.write(
        'Browser collection/execution contained zero cases, skips, interruptions or incomplete results. See sanitized timing.json.\n',
      );
      return { status: 'failed' };
    }
  }
}
