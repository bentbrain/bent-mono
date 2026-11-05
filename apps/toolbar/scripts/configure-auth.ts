import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { maintainRuntimeAuth } from './runtime-auth.js';
import { requireToolbarRelease } from './release-guard.js';
import { activeServiceOrigin } from '../src/server/proxy-configuration.js';
import { originSchema } from '../src/shared/models.js';

if (process.argv.slice(2).some((argument) => argument !== '--check'))
  throw new Error('Unsupported authentication command argument.');

await maintainRuntimeAuth(
  process.env,
  {
    qualify: requireToolbarRelease,
    list: async () => {
      const result = await promisify(execFile)('bun', ['x', 'wrangler', 'secret', 'list'], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const bindings: unknown = JSON.parse(result.stdout);
      return bindings;
    },
    verifyProxy: async (secret) => {
      const active = await activeServiceOrigin(
        originSchema.parse(process.env.FEEDBACK_API_ORIGIN),
        secret,
        '127.0.0.1',
      );
      if (active !== originSchema.parse(process.env.FEEDBACK_URL))
        throw new Error('The preserved Worker does not match the canonical release origin.');
    },
    write: async (configuration) => {
      const worker = spawn('bun', ['x', 'wrangler', 'secret', 'bulk'], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      worker.stdin.end(JSON.stringify(configuration));
      await new Promise<void>((resolve, reject) => {
        worker.once('error', () => {
          reject(new Error('Worker authentication could not start.'));
        });
        worker.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error('Worker authentication secrets could not be configured.'));
        });
      });
    },
  },
  { checkOnly: process.argv.includes('--check') },
);
