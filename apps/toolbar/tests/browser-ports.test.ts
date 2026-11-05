import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod';

void test('default browser service and example ports avoid Linux outbound allocation', async () => {
  const environment = { ...process.env };
  delete environment.FEEDBACK_E2E_PORT;
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import browser from './playwright.config.ts';
       import pins from './e2e/pins.config.ts';
       console.log(JSON.stringify([browser.use.baseURL, pins.use.baseURL]));`,
    ],
    { env: environment },
  );
  const origins = z.array(z.url()).length(2).parse(JSON.parse(result.stdout));
  const ports = origins.flatMap((origin) => {
    const url = new URL(origin);
    assert.equal(url.hostname, 'localhost');
    return [Number(url.port), Number(url.port) + 1];
  });
  assert.equal(new Set(ports).size, 4);
  // Linux automatically allocates source ports in 32768..60999. Earlier browser
  // traffic can occupy these ports even when no process is listening on them.
  // https://docs.kernel.org/networking/ip-sysctl.html#ip-variables
  for (const port of ports)
    assert.ok(
      port >= 1024 && port < 32768,
      `Browser fixture port ${port} overlaps outbound allocation`,
    );
});
