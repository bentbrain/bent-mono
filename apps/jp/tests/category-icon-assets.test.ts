import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  builtInCategoryIconUrl,
  isDefaultCategory,
} from '../src/lib/category-icons';
import { validateStoredCategoryIcon } from '../src/lib/category-icon-image';

void test('each approved category ships a distinct valid transparent pixel mask', async () => {
  const masks = new Set<string>();
  for (const name of [
    'food',
    'shopping',
    'landscape',
    'people',
    'beer',
    'origami',
  ]) {
    const url = builtInCategoryIconUrl(name);
    assert.ok(url);
    assert.equal(isDefaultCategory(name), true);
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    assert.equal(await validateStoredCategoryIcon(bytes), true, name);
    masks.add(bytes.toString('base64'));
  }
  assert.equal(masks.size, 6, 'categories must not share placeholder artwork');
  assert.equal(builtInCategoryIconUrl('custom category'), undefined);
  assert.equal(isDefaultCategory('custom category'), false);
});
