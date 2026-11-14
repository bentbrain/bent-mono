import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, check, parseJSON, sha256 } from '../release-v2/data.mjs';

const recipe = parseJSON(await readFile(new URL('./linux-candidate-recipe.json', import.meta.url)));
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const allowed = host => host === 'mcr.microsoft.com' || host.endsWith('.data.mcr.microsoft.com');
async function registryResponse(url, send) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const target = new URL(url); check(target.protocol === 'https:' && allowed(target.hostname) && !target.username && !target.password && !target.port, 'Native base registry origin differs');
    const response = await send(target.href, { redirect: 'manual', headers: { accept: manifestType } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel(); check(location, 'Native base redirect is incomplete'); url = new URL(location, target).href; continue;
    }
    check(response.status === 200 && response.body, 'Native base registry read failed'); return response;
  }
  throw Error('Native base registry redirect bound exceeded');
}
async function download(url, output, expected, send) {
  const response = await registryResponse(url, send), handle = await open(output, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of response.body) { const bytes = Buffer.from(chunk); size += bytes.length; check(size <= expected.size, 'Native base object exceeds descriptor'); hash.update(bytes); await handle.writeFile(bytes); }
    check(size === expected.size && hash.digest('hex') === expected.digest, 'Native base object digest or size differs');
  } finally { await handle.close(); await response.body?.cancel().catch(() => {}); }
}

/** Public immutable registry reads only. Caller retains the original bytes privately. */
export async function retrieveNativeBaseOci(destination, { send = fetch } = {}) {
  const imageDigest = recipe.baseImage.split('@sha256:')[1]; check(/^[a-f0-9]{64}$/.test(imageDigest), 'Pinned base manifest required');
  const response = await registryResponse(`https://mcr.microsoft.com/v2/playwright/manifests/sha256:${imageDigest}`, send);
  const parts = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; check(size <= 1024 * 1024, 'Native base manifest exceeds bound'); parts.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(parts), manifest = parseJSON(bytes);
  check(sha256(bytes) === imageDigest && manifest.schemaVersion === 2 && manifest.mediaType === manifestType &&
    manifest.config?.digest === recipe.baseConfigDigest && manifest.config.mediaType === 'application/vnd.oci.image.config.v1+json' && Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length <= 128, 'Pinned native base manifest/config differs');
  const descriptors = [manifest.config, ...manifest.layers];
  check(descriptors.every(ref => /^sha256:[a-f0-9]{64}$/.test(ref.digest) && Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= 512 * 1024 * 1024 &&
    !ref.urls && !ref.data && ['application/vnd.oci.image.config.v1+json', 'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd'].includes(ref.mediaType)) && descriptors.reduce((sum, ref) => sum + ref.size, 0) <= 2 * 1024 * 1024 * 1024, 'Native base descriptor closure exceeds bounds');
  await mkdir(destination, { mode: 0o700 }); const blobs = join(destination, 'blobs/sha256'); await mkdir(blobs, { recursive: true, mode: 0o700 });
  await writeFile(join(blobs, imageDigest), bytes, { mode: 0o600, flag: 'wx' });
  for (const descriptor of descriptors) await download(`https://mcr.microsoft.com/v2/playwright/blobs/${descriptor.digest}`, join(blobs, descriptor.digest.slice(7)),
    { size: descriptor.size, digest: descriptor.digest.slice(7) }, send);
  await writeFile(join(destination, 'oci-layout'), canonical({ imageLayoutVersion: '1.0.0' }), { mode: 0o600, flag: 'wx' });
  await writeFile(join(destination, 'index.json'), canonical({ schemaVersion: 2, manifests: [{ mediaType: manifestType, digest: `sha256:${imageDigest}`, size: bytes.length,
    platform: { os: 'linux', architecture: recipe.ociArchitecture } }] }), { mode: 0o600, flag: 'wx' });
  return { imageDigest, configDigest: recipe.baseConfigDigest.slice(7), bytes: descriptors.reduce((sum, ref) => sum + ref.size, bytes.length), runtimeQualified: false, awsImageQualified: false };
}
