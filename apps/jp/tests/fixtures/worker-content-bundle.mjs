import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../../astro.config.mjs';

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro'));
const cmsRequire = createRequire(require.resolve('emdash'));
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { build } = astroRequire('vite');
const { Miniflare } = wranglerRequire('miniflare');
const directory = await mkdtemp(
  join(process.cwd(), 'node_modules/.worker-content-'),
);
let runtime;
try {
  const entry = join(directory, 'entry.mjs');
  const sanitizer = cmsRequire.resolve('sanitize-html');
  await writeFile(
    entry,
    `
    import sanitize from ${JSON.stringify(sanitizer)};
    export default { fetch() {
      const html = sanitize('<p style="color:red;position:fixed" onclick="alert(1)">sample <a href="javascript:alert(1)">link</a><img src="https://example.test/sample.jpg" onerror="alert(1)"><script>alert(1)</script></p>', {
        allowedTags: ['p', 'a', 'img'],
        allowedAttributes: { p: ['style'], a: ['href'], img: ['src'] },
        allowedStyles: { p: { color: [/^red$/] } },
      });
      return Response.json({ html });
    }};
  `,
  );
  // Exercise the site's builtin-import conversion with the same CommonJS dependency
  // as PortableText's HtmlBlock, then execute the emitted ESM in real workerd.
  const bundled = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    plugins: config.vite?.plugins,
    ssr: { ...config.vite?.ssr, noExternal: true },
    build: {
      ssr: entry,
      write: false,
      minify: false,
      rolldownOptions: {
        platform: 'browser',
        output: { format: 'esm', codeSplitting: false },
      },
    },
  });
  assert.ok(!Array.isArray(bundled) && 'output' in bundled);
  const chunks = bundled.output.filter((item) => item.type === 'chunk');
  assert.equal(chunks.length, 1);
  const code = chunks[0]?.code;
  assert.ok(code);
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'sample-content',
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'entry.mjs',
            modulesRoot: directory,
            modules: { 'entry.mjs': { type: 'esm', contents: code } },
          },
        },
        dev: { rootPath: directory },
      },
    ],
  });
  const response = await runtime.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    html: '<p style="color:red">sample <a>link</a><img src="https://example.test/sample.jpg" /></p>',
  });
  console.log(
    'Workers content bundle loads; CSS parsing, safe HTML/media and unsafe-content removal pass.',
  );
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
