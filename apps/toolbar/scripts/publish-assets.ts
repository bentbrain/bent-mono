import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { requireToolbarRelease } from './release-guard.js';
import {
  prepareReleaseBundle,
  releaseBundle,
  releaseMetadata,
  verifyReleaseArtifacts,
} from './release-artifacts.js';

if (process.argv.length !== 2) throw new Error('Asset publication accepts no command arguments.');

const version = await requireToolbarRelease();
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .parse(process.env.GITHUB_REPOSITORY);
await prepareReleaseBundle('dist');
let metadata = await releaseMetadata(version);
if (!metadata) {
  await requireToolbarRelease();
  await promisify(execFile)(
    'gh',
    [
      'release',
      'create',
      `assets-${version}`,
      `dist/${releaseBundle}`,
      '--repo',
      repository,
      '--target',
      version,
      '--title',
      `Production assets ${version.slice(0, 12)}`,
      '--notes',
      `Browser assets built from protected production commit ${version}.`,
      '--prerelease',
      '--latest=false',
    ],
    { timeout: 120_000 },
  );
  metadata = await releaseMetadata(version);
}
if (!metadata?.assets.some((asset) => asset.name === releaseBundle))
  throw new Error('The production release is missing its browser asset bundle.');
await verifyReleaseArtifacts('dist', version, metadata);
console.log('Archived and verified production browser assets.');
