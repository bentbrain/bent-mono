import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (!/^[a-f0-9]{40}$/.test(sha))
  throw new Error('Deployment requires an exact source commit');
// The root gate verifies the current main SHA and authoritative Quality run.
// Independent review belongs to the PR head, never the squash-main SHA.
execFileSync(
  process.execPath,
  [
    fileURLToPath(
      new URL('../../../scripts/require-release-checks.mjs', import.meta.url),
    ),
    '--sha',
    sha,
  ],
  { stdio: 'inherit' },
);
