import type { IconEnvironment } from './category-icon-jobs';
import { validateStoredCategoryIcon } from './category-icon-image';

export interface IconAsset {
  storage_key: string;
  category_id: string;
  normalized: string;
  label: string;
  version: string;
}

// Conservative visual subjects. Modifiers must match as well: a beer bottle
// must not silently reuse a beer glass, nor iced tea a hot tea icon.
const subjects = [
  ['ramen', 'noodle', 'noodles'],
  ['coffee', 'cafe', 'cafes', 'café', 'cafés'],
  ['bicycle', 'bicycles', 'bike', 'bikes', 'cycling'],
  ['train', 'trains', 'railway', 'railways'],
  ['cat', 'cats'],
  ['dog', 'dogs'],
  ['mountain', 'mountains'],
  ['beach', 'beaches'],
  ['flower', 'flowers'],
];
function subject(name: string) {
  return name
    .split(' ')
    .map((word) => subjects.find((group) => group.includes(word))?.[0] || word)
    .join(' ');
}
export async function iconAssets(env: IconEnvironment) {
  return (
    await env.DB.prepare(
      'SELECT * FROM jp_icon_assets ORDER BY normalized,version',
    ).all<IconAsset>()
  ).results;
}
export async function validIconAsset(env: IconEnvironment, asset: IconAsset) {
  if (
    !/^[a-f0-9]{64}$/.test(asset.category_id) ||
    !/^[a-f0-9]{64}$/.test(asset.version) ||
    asset.storage_key !==
      `category-icons/${asset.category_id}/${asset.version}.png`
  )
    return undefined;
  const object = await env.MEDIA.get(asset.storage_key);
  if (
    !object ||
    object.size > 8192 ||
    object.httpMetadata?.contentType !== 'image/png'
  )
    return undefined;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return (await validateStoredCategoryIcon(bytes)) ? bytes : undefined;
}
export async function matchingIcon(env: IconEnvironment, normalized: string) {
  const candidates = (await iconAssets(env)).filter(
    (asset) => subject(asset.normalized) === subject(normalized),
  );
  // Prefer an exact label before a synonym and verify storage before reuse.
  candidates.sort(
    (a, b) =>
      Number(b.normalized === normalized) - Number(a.normalized === normalized),
  );
  for (const asset of candidates)
    if (await validIconAsset(env, asset)) return asset;
  return undefined;
}
