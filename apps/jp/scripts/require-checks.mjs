import { execFileSync } from 'node:child_process';
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^bentbrain\/japan-blog$/.test(repository))
  throw new Error('Unexpected deployment repository');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const data = JSON.parse(
  execFileSync(
    'gh',
    ['api', `repos/${repository}/commits/${sha}/check-runs?per_page=100`],
    { encoding: 'utf8' },
  ),
);
const required = [
  'lint',
  'typecheck',
  'test',
  'knip',
  'build',
  'test:integration',
  'browser',
  'secret-scan',
  'CodeQL',
];
for (const name of required) {
  const check = data.check_runs
    .filter((run) => run.name === name && run.head_sha === sha)
    .sort((a, b) => b.id - a.id)[0];
  if (!check || check.conclusion !== 'success')
    throw new Error(`Deployment blocked by ${name}`);
}
console.log(`All required checks passed for ${sha}.`);
