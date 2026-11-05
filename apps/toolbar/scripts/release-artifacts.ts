import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { readRegularFile } from '../src/shared/files.js';

// Releases published before the framework migration contain these individual files.
export const releaseFiles = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
export const releaseBundle = 'browser-assets.bundle.json';
const requiredFiles = ['toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
const assetPath = z
  .string()
  .regex(
    /^(?:app\.js|toolbar\.js|embed\.js|embed-module\.js|styles\.css|dashboard-assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?))$/,
  );
const bundleSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: assetPath,
            contents: z
              .string()
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict(),
      )
      .min(5)
      .max(1000),
  })
  .strict();
const invoke = promisify(execFile);
const releaseSchema = z.object({
  tag_name: z.string(),
  target_commitish: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().max(8 * 1024 * 1024),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
  ),
});
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const migratedArchiveSchema = z
  .object({
    version: z.literal(1),
    legacyAssetSha: z.string().regex(/^[a-f0-9]{40}$/),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    newRepository: repositorySchema,
    releaseTag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/),
    targetCommitish: z.string().regex(/^[a-f0-9]{40}$/),
    assets: z
      .array(
        z
          .object({
            name: z.literal(releaseBundle),
            size: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 * 1024),
            digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();
const repository = () => repositorySchema.parse(process.env.GITHUB_REPOSITORY);
type ArchiveCommand = (args: string[], token?: string) => Promise<string>;
const archiveCommand: ArchiveCommand = async (args, token) => {
  const result = await invoke('gh', args, {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
  return result.stdout;
};
const tagFor = (version: string) =>
  `assets-${z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(version)}`;

function validatePaths(paths: string[]) {
  for (const path of paths) assetPath.parse(path);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate browser asset path.');
  if (requiredFiles.some((file) => !paths.includes(file)))
    throw new Error('Required browser asset missing.');
  if (!paths.includes('app.js') && !paths.some((file) => file.startsWith('dashboard-assets/')))
    throw new Error('Dashboard browser assets missing.');
  return paths;
}

export async function localBrowserAssets(directory: string): Promise<string[]> {
  const manifest = (await readRegularFile(`${directory}/browser-assets.json`)).contents;
  return validatePaths(z.array(assetPath).parse(JSON.parse(manifest.toString('utf8'))));
}

export function browserAssetSource(directory: string, path: string) {
  assetPath.parse(path);
  return path.startsWith('dashboard-assets/')
    ? `${directory}/dashboard/client/${path}`
    : `${directory}/${path}`;
}

export async function releaseAssetPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  async function collect(current: string, prefix: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory() && path === 'dashboard-assets')
        await collect(`${current}/${entry.name}`, `${path}/`);
      else if (entry.isFile()) paths.push(assetPath.parse(path));
      else throw new Error('Invalid browser asset entry.');
    }
  }
  await collect(directory, '');
  return validatePaths(paths.sort());
}

export async function prepareReleaseBundle(directory: string) {
  const files = [];
  for (const path of (await localBrowserAssets(directory)).sort()) {
    const contents = (await readRegularFile(browserAssetSource(directory, path))).contents;
    files.push({ path, contents: contents.toString('base64') });
  }
  const contents = JSON.stringify({ version: 1, files });
  if (Buffer.byteLength(contents) > 8 * 1024 * 1024)
    throw new Error('Release bundle exceeds the size limit.');
  await writeFile(`${directory}/${releaseBundle}`, contents);
}

function parseBundle(contents: Buffer) {
  const bundle = bundleSchema.parse(JSON.parse(contents.toString('utf8')));
  validatePaths(bundle.files.map((file) => file.path));
  return bundle;
}

async function metadataFor(
  version: string,
  source: string,
  command: ArchiveCommand,
  token?: string,
) {
  return metadataByTag(tagFor(version), source, command, token);
}

async function metadataByTag(tag: string, source: string, command: ArchiveCommand, token?: string) {
  try {
    const contents = await command(['api', `repos/${source}/releases/tags/${tag}`], token);
    return releaseSchema.parse(JSON.parse(contents));
  } catch (error) {
    const failure = z.object({ stderr: z.string() }).safeParse(error);
    if (failure.success && /\bHTTP 404\b/.test(failure.data.stderr)) return null;
    throw new Error('Could not read the repository release artifact metadata.');
  }
}

export async function releaseMetadata(version: string) {
  return metadataFor(version, repository(), archiveCommand);
}

export async function verifyReleaseArtifacts(
  directory: string,
  version: string,
  metadata: unknown,
) {
  const release = releaseSchema.parse(metadata);
  if (release.tag_name !== tagFor(version) || release.target_commitish !== version)
    throw new Error('Release artifacts do not belong to the active commit.');
  await verifyAssetContents(directory, release);
}

async function verifyAssetContents(directory: string, release: z.infer<typeof releaseSchema>) {
  const files = release.assets.some((asset) => asset.name === releaseBundle)
    ? [releaseBundle]
    : releaseFiles;
  for (const file of files) {
    const matches = release.assets.filter((asset) => asset.name === file);
    const asset = matches[0];
    if (!asset) throw new Error(`Release artifact missing: ${file}`);
    if (matches.length !== 1) throw new Error(`Duplicate release artifact: ${file}`);
    const contents = (await readRegularFile(`${directory}/${file}`)).contents;
    const digest = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
    if (contents.length !== asset.size || digest !== asset.digest)
      throw new Error(`Release artifact digest differs: ${file}`);
    if (file === releaseBundle) parseBundle(contents);
  }
}

export async function retrieveReleaseArtifacts(
  version: string,
  directory: string,
  options: { environment?: NodeJS.ProcessEnv; command?: ArchiveCommand } = {},
) {
  const environment = options.environment ?? process.env;
  const command = options.command ?? archiveCommand;
  let source = repositorySchema.parse(environment.GITHUB_REPOSITORY);
  let tag = tagFor(version);
  let token: string | undefined;
  let migrated: z.infer<typeof migratedArchiveSchema> | undefined;
  let metadata = await metadataFor(version, source, command);
  if (!metadata && environment.TOOLBAR_MIGRATED_ARCHIVE_JSON) {
    try {
      migrated = migratedArchiveSchema.parse(JSON.parse(environment.TOOLBAR_MIGRATED_ARCHIVE_JSON));
    } catch {
      throw new Error('Invalid protected migrated-archive receipt.');
    }
    const asset = migrated.assets[0];
    if (
      !asset ||
      migrated.legacyAssetSha !== version ||
      migrated.newRepository !== source ||
      asset.digest !== `sha256:${migrated.archiveSha256}`
    )
      throw new Error('Migrated asset receipt does not match the active release and archive.');
    tag = migrated.releaseTag;
    metadata = await metadataByTag(tag, source, command);
    if (
      metadata?.tag_name !== tag ||
      metadata.target_commitish !== migrated.targetCommitish ||
      metadata.assets.length !== 1 ||
      metadata.assets[0]?.name !== asset.name ||
      metadata.assets[0].size !== asset.size ||
      metadata.assets[0].digest !== asset.digest
    )
      throw new Error('Migrated archive metadata differs from its protected receipt.');
  } else if (!metadata && environment.TOOLBAR_LEGACY_ARCHIVE_REPOSITORY) {
    const legacy = repositorySchema.parse(environment.TOOLBAR_LEGACY_ARCHIVE_REPOSITORY);
    if (legacy === source) throw new Error('Legacy asset archive must be a separate repository.');
    token = environment.TOOLBAR_LEGACY_ARCHIVE_TOKEN?.trim();
    if (!token) throw new Error('Legacy asset archive requires its protected read credential.');
    source = legacy;
    metadata = await metadataFor(version, source, command, token);
  }
  if (!metadata) throw new Error('The active commit has no archived release assets.');
  const temporary = await mkdtemp(join(tmpdir(), 'feedback-release-'));
  try {
    const files = metadata.assets.some((asset) => asset.name === releaseBundle)
      ? [releaseBundle]
      : releaseFiles;
    for (const file of files) {
      try {
        await command(
          ['release', 'download', tag, '--repo', source, '--pattern', file, '--dir', temporary],
          token,
        );
      } catch {
        throw new Error('Could not download the archived browser assets.');
      }
    }
    if (migrated) await verifyAssetContents(temporary, metadata);
    else await verifyReleaseArtifacts(temporary, version, metadata);
    if (files.includes(releaseBundle)) {
      const bundle = parseBundle((await readRegularFile(`${temporary}/${releaseBundle}`)).contents);
      for (const file of bundle.files) {
        const path = `${directory}/${file.path}`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.contents, 'base64'), { flag: 'wx' });
      }
    } else {
      await mkdir(directory, { recursive: true });
      for (const file of files)
        await writeFile(
          `${directory}/${file}`,
          (await readRegularFile(`${temporary}/${file}`)).contents,
          { flag: 'wx' },
        );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
