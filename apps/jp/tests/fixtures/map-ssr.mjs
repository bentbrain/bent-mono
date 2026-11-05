import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { experimental_AstroContainer } from 'astro/container';
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro'));
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { transform } = astroRequire('@astrojs/compiler-rs');
const { build } = wranglerRequire('esbuild');
const budget = { dbAccesses: 0, bucketAccesses: 0 };
const budgetKey = Symbol.for('synthetic-map-ssr-budget');
globalThis[budgetKey] = budget;
const directory = await mkdtemp(join(process.cwd(), 'node_modules/.map-ssr-'));
try {
  const source = await readFile('src/components/JapanMap.astro', 'utf8');
  const compiled = await transform(source, {
    filename: 'src/components/JapanMap.astro',
    internalURL: 'astro/compiler-runtime',
    resultScopedSlot: true,
    resolvePath: (specifier) => specifier,
  });
  await build({
    stdin: {
      contents: compiled.code,
      resolveDir: join(process.cwd(), 'src/components'),
      loader: 'ts',
    },
    outfile: join(directory, 'component.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    plugins: [
      {
        name: 'observe-map-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'env',
            namespace: 'budget',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'budget' }, () => ({
            contents:
              'const budget=globalThis[Symbol.for("synthetic-map-ssr-budget")]; export const env={get DB(){budget.dbAccesses++;throw new Error("SSR must not query dimensions")},get MEDIA(){budget.bucketAccesses++;throw new Error("SSR must not read headers")}}',
          }));
          builder.onResolve({ filter: /^\.\/JapanMapView$/ }, () => ({
            path: 'view',
            namespace: 'observe',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'observe' }, () => ({
            contents:
              'import {createComponent,render} from "astro/runtime/server/index.js"; export const JapanMapView=createComponent((result,props)=>render`<pre>${JSON.stringify(props.points)}</pre>`);',
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  const { default: Map } = await import(
    pathToFileURL(join(directory, 'component.mjs')).href
  );
  const container = await experimental_AstroContainer.create();
  for (const count of [600, 1200]) {
    const media = Array.from({ length: count }, (_, index) => ({
      id: `01${String(index + 1).padStart(24, '0')}`,
      slug: null,
      title: 'synthetic',
      place: 'synthetic',
      kind: 'photo',
      captured_at: new Date('2099-10-15T00:00:00Z'),
      latitude: 35,
      longitude: 139,
      categories: [],
      poster_url: `/_emdash/api/media/file/trip/00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}/photo.jpg`,
    }));
    const start = performance.now();
    const html = await container.renderToString(Map, {
      props: { media },
      locals: { privateMediaRender: false },
    });
    assert.deepEqual(budget, { dbAccesses: 0, bucketAccesses: 0 });
    assert.equal((html.match(/photoResolution/g) || []).length, count);
    assert.equal((html.match(/\/map-photo\//g) || []).length, count);
    assert.equal((html.match(/&quot;id&quot;/g) || []).length, count);
    console.log(
      JSON.stringify({
        count,
        incrementalDimensionQueries: 0,
        headerReads: 0,
        headerBytes: 0,
        componentMs: performance.now() - start,
      }),
    );
    const privateHtml = await container.renderToString(Map, {
      props: { media },
      locals: { privateMediaRender: true },
    });
    assert.equal(privateHtml.includes('/map-photo/'), false);
  }
} finally {
  delete globalThis[budgetKey];
  await rm(directory, { recursive: true, force: true });
}
