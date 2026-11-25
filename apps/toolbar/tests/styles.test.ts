import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

void test('dashboard styles scan application sources and exclude repository documentation', async () => {
  const app = new URL('../', import.meta.url);
  const dashboard = new URL('src/browser/dashboard/', app);
  const compiler = await compile(await readFile(new URL('dashboard.css', dashboard), 'utf8'), {
    base: fileURLToPath(dashboard),
    onDependency: () => undefined,
  });
  // Match the automatic root used by the dashboard's Tailwind Vite plugin.
  const root = compiler.root ?? { base: fileURLToPath(app), pattern: '**/*' };
  const sources = root === 'none' ? [] : [{ ...root, negated: false }];
  const scanner = new Scanner({ sources: [...sources, ...compiler.sources] });
  scanner.scan();
  const files = new Set(scanner.files);
  assert.ok(files.has(fileURLToPath(new URL('root.tsx', dashboard))));
  for (const document of ['README.md', 'LICENSE']) {
    assert.ok(
      !files.has(fileURLToPath(new URL(document, app))),
      `${document} affects dashboard CSS`,
    );
  }
});
