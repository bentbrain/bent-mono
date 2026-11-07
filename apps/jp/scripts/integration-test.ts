import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { runBrowserContracts } from './integration-browser-contracts';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { assertStatus, serverSignals } from './integration-diagnostics';

function assertPublicSignups(html: string, path: string) {
  const { document, Node } = new JSDOM(html).window;
  const signups = document.querySelectorAll(
    '[data-feedback-id="newsletter-signup"]',
  );
  const homepage = path === '/' || path.startsWith('/?');
  assert.equal(signups.length, homepage ? 2 : 1, `Signup count on ${path}`);
  const ids: string[] = [];
  for (const signup of signups) {
    assert.equal(signup.getAttribute('aria-label'), 'newsletter');
    assert.equal(signup.querySelector('h2'), null);
    const form = signup.querySelector('form');
    assert.ok(form?.hasAttribute('data-feedback-private'));
    assert.ok(form?.hasAttribute('data-feedback-redact'));
    for (const name of ['email', 'website']) {
      const input = signup.querySelector(`input[name="${name}"]`);
      assert.ok(input?.id, `Missing ${name} ID on ${path}`);
      ids.push(input.id);
      assert.equal(document.querySelectorAll(`[id="${input.id}"]`).length, 1);
      const label = signup.querySelector(`label[for="${input.id}"]`);
      assert.ok(label);
      assert.equal(label.textContent.trim(), name);
      if (name === 'email') assert.ok(label.classList.contains('sr-only'));
    }
    assert.equal(signup.querySelector('a'), null);
  }
  assert.equal(new Set(ids).size, ids.length);
  const footer = document.querySelector('body > footer');
  assert.ok(footer);
  const footerSignup = footer.querySelector(
    '[data-feedback-id="newsletter-signup"]',
  );
  assert.ok(footerSignup);
  assert.equal(
    footer.querySelectorAll('[data-feedback-id="newsletter-signup"]').length,
    1,
  );
  const shop = footer.querySelector('[data-feedback-id="shop-ad"]');
  if (shop)
    assert.ok(
      footerSignup.compareDocumentPosition(shop) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const main = document.querySelector('main');
  assert.ok(main);
  assert.equal(
    main.querySelectorAll('[data-feedback-id="newsletter-signup"]').length,
    homepage ? 1 : 0,
  );
  if (homepage) {
    const top = main.querySelector('[data-feedback-id="newsletter-signup"]');
    const map = main.querySelector('.journal-map-card');
    assert.ok(
      top &&
        map &&
        top.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }
  assert.equal(
    document.querySelectorAll('a[href="/newsletter/privacy"]').length,
    1,
  );
  assert.ok(footer.querySelector('a[href="/newsletter/privacy"]'));
}

const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
if (!address || typeof address === 'string')
  throw new Error('Integration port required');
const port = String(address.port);
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => {
    if (error) reject(error);
    else resolve();
  }),
);
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  'bun',
  [
    'dev',
    '--config',
    'tests/fixtures/map-library.config.mjs',
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--ignore-lock',
  ],
  {
    env: { ...process.env, TEST_EPHEMERAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);
let logs = '';
const started = Date.now();
const diagnosticSignals: { atMs: number; signals: string[] }[] = [];
function captureOutput(value: Buffer) {
  const output = value.toString();
  logs = (logs + output).slice(-8000);
  const signals = serverSignals(output);
  if (signals.length)
    diagnosticSignals.push({ atMs: Date.now() - started, signals });
}
server.stdout.on('data', captureOutput);
server.stderr.on('data', captureOutput);
let cookie = '';
const item = z.object({
  success: z.literal(true),
  data: z.object({
    item: z.object({ id: z.string(), data: z.record(z.string(), z.unknown()) }),
    _rev: z.string().optional(),
  }),
});
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signed = true,
) {
  const retrySafe =
    method === 'GET' ||
    /\/_emdash\/api\/(setup\/dev-bypass|auth\/(dev-bypass|invite(?:\/|$)))/.test(
      path,
    );
  for (let attempt = 0; ; attempt++) {
    const url = new URL(path, base);
    assert.equal(
      url.origin,
      base,
      'Integration request must stay on the local server',
    );
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        Origin: base,
        'X-EmDash-Request': '1',
        ...(signed ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = await response.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    // The Vite proxy can lose its internal workerd connection. Preserve the
    // existing retries for its identifiable dispatch error, only
    // for reads and idempotent setup or denied invitation probes. Application
    // errors and content mutations are never retried.
    if (
      retrySafe &&
      attempt < 3 &&
      response.status === 500 &&
      text.includes('fetch failed') &&
      text.includes('_Miniflare.dispatchFetch')
    ) {
      console.log(`Cloudflare dev proxy reconnected for ${method} ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    if (response.status >= 500)
      await assertStatus(
        new Response(bytes, {
          status: response.status,
          headers: response.headers,
        }),
        'below 500',
        `${method} integration request`,
        diagnosticSignals,
      );
    return new Response([204, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  }
}
const transport = {
  request,
  raw: async (path: string, init: RequestInit, signed = true) => {
    const headers = new Headers(init.headers);
    if (signed) headers.set('Cookie', cookie);
    // Multipart uploads still pass the ordinary same-origin owner checks.
    if (init.body instanceof FormData) {
      headers.set('Origin', base);
      headers.set('X-EmDash-Request', '1');
    }
    return fetch(base + path, { ...init, headers, redirect: 'manual' });
  },
};
async function publish(collection: string, id: string) {
  const current = item.parse(
    await (await request(`/_emdash/api/content/${collection}/${id}`)).json(),
  );
  return request(`/_emdash/api/content/${collection}/${id}/publish`, {
    _rev: current.data._rev,
  });
}
async function run() {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + '/_emdash/api/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, logs);
  for (const path of ['/.env', '/.git/config', '/wp-login.php']) {
    const response = await fetch(base + path);
    const body = await response.text();
    // A checkout has a .git directory; a worktree has a .git file. Vite can
    // reject the former before forwarding it to the Worker. Verify that denial
    // explicitly rather than requiring the request to bypass Vite's protection.
    if (path === '/.git/config' && response.status === 403) {
      assert.match(body, /<h1>403 Restricted<\/h1>/);
      assert.match(body, /outside of Vite serving allow list/);
      continue;
    }
    assert.equal(response.status, 404, path);
    assert.equal(body, '', `CMS rendered probe ${path}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  console.log(
    JSON.stringify({
      phase: 'integration-server-ready',
      elapsedMs: Date.now() - started,
    }),
  );
  const setup = await request(
    '/_emdash/api/setup/dev-bypass',
    {},
    'POST',
    false,
  );
  assert.equal(setup.status, 200, await setup.text());
  const login = await request(
    '/_emdash/api/auth/dev-bypass',
    undefined,
    'GET',
    false,
  );
  const loginBody = await login.text();
  assert.equal(login.status, 200, loginBody);
  cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(cookie, 'Development session missing');
  const emptyGallery = await (
    await request('/gallery', undefined, 'GET', false)
  ).text();
  assert.ok(!emptyGallery.includes('aria-label="Media categories"'));
  assert.ok(emptyGallery.includes('<footer'));
  assert.ok(!emptyGallery.includes('theme-toggle'));
  for (const path of [
    '/',
    '/?cursor=',
    '/gallery',
    '/newsletter/privacy',
    '/404',
  ]) {
    const html = await (await request(path, undefined, 'GET', false)).text();
    assertPublicSignups(html, path);
  }
  for (const path of [
    '/newsletter/confirm',
    '/categories',
    '/owner',
    '/owner/media',
    '/owner/posts/new',
    '/owner/newsletter',
    '/owner/export',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.ok(
      !(await response.text()).includes('data-feedback-id="newsletter-signup"'),
      `Private signup on ${path}`,
    );
  }
  // Import endpoint modules through safe reads before stateful requests, so
  // dependency optimization does not interrupt an upload or content save.
  for (const path of [
    '/_emdash/api/media',
    '/api/trip/upload',
    '/api/trip/posts',
    '/api/trip/category-icons',
  ]) {
    const warmed = await request(path, undefined, 'GET');
    assert.ok(
      warmed.status < 500,
      `Could not initialize ${path}: ${await warmed.text()}\n${logs}`,
    );
  }
  for (const { collection, field } of [
    { collection: 'posts', field: 'day' },
    { collection: 'beers', field: 'day' },
    { collection: 'media_items', field: 'captured_at' },
  ]) {
    const updated = await request(
      `/_emdash/api/schema/collections/${collection}/fields/${field}`,
      { indexed: true },
      'PUT',
    );
    assert.equal(updated.status, 200, await updated.text());
  }
  console.log(
    JSON.stringify({
      phase: 'integration-setup-ready',
      elapsedMs: Date.now() - started,
    }),
  );
  if (process.argv.includes('--browser-contracts-only')) {
    await runBrowserContracts(transport);
    return;
  }
  assert.equal(
    (await request('/api/trip/media', undefined, 'GET', false)).status,
    401,
  );
  assert.equal((await request('/owner', undefined, 'GET', false)).status, 302);
  assert.equal(
    (
      await fetch(base + '/api/trip/beers', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: '2099-10-14', count: 5 }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/_emdash/api/admin/users', undefined, 'GET')).status,
    403,
  );
  for (const path of [
    '/_emdash/api/auth/invite',
    '/_emdash/api/auth/invite/accept',
    '/_emdash/api/auth/invite/register-options',
    '/_emdash/api/auth/invite/complete',
  ]) {
    assert.equal((await request(path, {}, 'POST')).status, 403);
    const anonymous = await request(path, {}, 'POST', false);
    assert.ok(
      [401, 403].includes(anonymous.status),
      `Invitation endpoint ${path}: expected denial, received ${String(anonymous.status)} ${await anonymous.text()}\n${logs}`,
    );
  }
  for (const method of ['GET', 'POST']) {
    const anonymous = await request(
      '/api/trip/category-icons',
      method === 'POST' ? { category: 'private fixture' } : undefined,
      method,
      false,
    );
    assert.equal(anonymous.status, 401);
  }
  // Exercise consecutive early denials with bodies on the same dev transport.
  // Each probe is sent once; every status must be 403, including proxy failures.
  for (let probe = 0; probe < 100; probe++) {
    for (const headers of [
      new Headers({ Cookie: cookie, 'Content-Type': 'application/json' }),
      new Headers({
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.invalid',
        'X-EmDash-Request': '1',
      }),
      new Headers({
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: base,
      }),
    ])
      await assertStatus(
        await fetch(base + '/api/trip/category-icons', {
          method: 'POST',
          headers,
          body: JSON.stringify({ category: 'private fixture' }),
        }),
        403,
        `category-icon CSRF rejection probe ${String(probe)}`,
        diagnosticSignals,
      );
  }
  assert.equal(
    (
      await request('/api/trip/category-icons', {
        category: 'not a saved category',
      })
    ).status,
    404,
  );
  const providerPath = '/api/trip/category-icons/provider';
  for (const method of ['GET', 'POST'])
    assert.equal(
      (
        await request(
          providerPath,
          method === 'POST' ? { action: 'resume' } : undefined,
          method,
          false,
        )
      ).status,
      401,
    );
  for (const headers of [
    new Headers({ Cookie: cookie, 'Content-Type': 'application/json' }),
    new Headers({
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: 'https://attacker.invalid',
      'X-EmDash-Request': '1',
    }),
    new Headers({
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: base,
    }),
  ])
    await assertStatus(
      await fetch(base + providerPath, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'resume' }),
      }),
      403,
      'category provider CSRF rejection',
      diagnosticSignals,
    );
  const providerStatus = await request(providerPath);
  assert.equal(providerStatus.status, 200);
  assert.match(providerStatus.headers.get('Cache-Control') || '', /no-store/);
  assert.match(
    providerStatus.headers.get('CDN-Cache-Control') || '',
    /no-store/,
  );
  assert.deepEqual(await providerStatus.json(), {
    paused: false,
    canResume: false,
  });
  for (const body of [
    {},
    { action: 'retry' },
    { action: 'resume', acknowledgeCharge: true },
  ])
    assert.equal((await request(providerPath, body)).status, 400);
  assert.equal((await request(providerPath, { action: 'resume' })).status, 409);
  const iconStatus = await request('/api/trip/category-icons');
  assert.match(iconStatus.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(
    (
      await request(
        '/_emdash/api/media/file/category-icons/guessed/key.png',
        undefined,
        'GET',
        false,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        '/_emdash/api/media/file/category%2Dicons/guessed/key.png',
        undefined,
        'GET',
        false,
      )
    ).status,
    404,
  );
  const photo = await readFile('public/demo/tokyo.jpg'),
    video = await readFile('public/demo/sample.mp4');
  const form = new FormData();
  form.set('original', new File([video], 'sample.mp4', { type: 'video/mp4' }));
  form.set('display', new File([video], 'sample.mp4', { type: 'video/mp4' }));
  form.set('poster', new File([photo], 'poster.jpg', { type: 'image/jpeg' }));
  const uploaded = await fetch(base + '/api/trip/upload', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'X-EmDash-Request': '1' },
    body: form,
  });
  const uploadBody: unknown = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));
  const id = item.parse(uploadBody).data.item.id;
  assert.equal(
    (await publish('media_items', id)).status,
    422,
    'Locationless upload published',
  );
  const current = item.parse(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
  );
  const draftAsset = {
    id: z.object({ id: z.string() }).parse(current.data.item.data.asset).id,
    url: z.string().parse(current.data.item.data.source_url),
  };
  assert.equal(
    (await request(draftAsset.url, undefined, 'GET', false)).status,
    404,
    'Draft media bytes exposed',
  );
  assert.equal(
    (await request(`/_emdash/api/media/asset/${draftAsset.id}/video.mp4`))
      .status,
    200,
    'Owner draft preview denied',
  );
  const originalKey = z.string().parse(current.data.item.data.original_key);
  assert.equal(
    (
      await request(
        `/_emdash/api/media/file/${originalKey}`,
        undefined,
        'GET',
        false,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/_image?href=${encodeURIComponent('/_emdash/api/media/file/' + originalKey)}&w=100`,
        undefined,
        'GET',
        false,
      )
    ).status,
    404,
  );
  const metadata = {
    title: 'Integration video',
    captured_at: '2099-10-15T00:15:00+09:00',
    latitude: 35.6895,
    longitude: 139.6917,
    place: 'tokyo',
    categories: ['food', 'shopping', '  Synthetic Ramen  '],
  };
  for (const encoded of ['trip%2Dprivate', '%2574rip-private']) {
    const path = originalKey.replace('trip-private', encoded);
    assert.equal(
      (
        await request(
          `/_emdash/api/media/file/${path}`,
          undefined,
          'GET',
          false,
        )
      ).status,
      404,
    );
  }
  const bad = await request(
    '/api/trip/media',
    {
      id,
      revision: current.data._rev,
      publish: true,
      metadata: { ...metadata, latitude: 95 },
    },
    'PATCH',
  );
  assert.equal(bad.status, 400);
  const saved = await request(
    '/api/trip/media',
    { id, revision: current.data._rev, publish: true, metadata },
    'PATCH',
  );
  assert.equal(saved.status, 200, await saved.text());
  const customStatus = await request('/api/trip/category-icons');
  const customIcons = z
    .object({
      icons: z.array(
        z.object({
          label: z.string(),
          normalized: z.string(),
          state: z.string(),
          canRetry: z.boolean(),
        }),
      ),
    })
    .parse(await customStatus.json()).icons;
  assert.deepEqual(
    customIcons.find((icon) => icon.normalized === 'synthetic ramen'),
    {
      label: 'Synthetic Ramen',
      normalized: 'synthetic ramen',
      state: 'setup',
      canRetry: false,
    },
  );
  const afterSave = item.parse(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
  );
  assert.deepEqual(afterSave.data.item.data.categories, [
    'food',
    'shopping',
    'Synthetic Ramen',
  ]);
  const draftCategory = 'private-only-icon-fixture';
  const draftEdit = await request(
    `/_emdash/api/content/media_items/${id}`,
    { _rev: afterSave.data._rev, data: { categories: [draftCategory] } },
    'PUT',
  );
  assert.equal(draftEdit.status, 200, await draftEdit.text());
  const draftStatuses = JSON.stringify(
    await (await request('/api/trip/category-icons')).json(),
  );
  assert.ok(
    draftStatuses.includes(draftCategory),
    'Owner cannot see staged category status',
  );
  const publicBeforePublish = await (
    await request('/gallery', undefined, 'GET', false)
  ).text();
  assert.ok(
    !publicBeforePublish.includes(draftCategory),
    'Draft category leaked in public gallery',
  );
  assert.ok(
    publicBeforePublish.includes('Synthetic Ramen'),
    'Published category disappeared after draft save',
  );
  const staged = item.parse(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
  );
  const restored = await request(
    '/api/trip/media',
    { id, revision: staged.data._rev, publish: true, metadata },
    'PATCH',
  );
  assert.equal(restored.status, 200, await restored.text());
  const privateHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('never-published-icon-fixture'),
  );
  const iconId = [...new Uint8Array(privateHash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const deniedIcon = await request(
    `/category-icons/${iconId}/${'a'.repeat(64)}.png`,
    undefined,
    'GET',
    false,
  );
  assert.equal(deniedIcon.status, 404, `${await deniedIcon.text()}\n${logs}`);
  assert.match(deniedIcon.headers.get('Cache-Control') || '', /no-store/);
  for (let index = 0; index < 101; index++) {
    const draft = await request('/_emdash/api/content/media_items', {
      slug: `pagination-${String(index)}-${crypto.randomUUID()}`,
      data: { title: 'Pagination fixture', kind: 'photo' },
    });
    assert.equal(draft.status, 201, await draft.text());
  }
  const libraryResponse = await request('/api/trip/media');
  const libraryBody: unknown = await libraryResponse.json();
  assert.equal(libraryResponse.status, 200, JSON.stringify(libraryBody));
  const library = z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          data: z.object({
            asset: z.object({ id: z.string(), url: z.string() }).nullish(),
          }),
        }),
      ),
    })
    .parse(libraryBody);
  const asset = library.items.find((entry) => entry.id === id)?.data.asset;
  assert.ok(asset);
  const ranged = await fetch(base + draftAsset.url, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('Cache-Control') || '', /no-store/);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  const renameRevision = item.parse(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
  ).data._rev;
  const renamed = await request(
    `/_emdash/api/content/media_items/${id}`,
    {
      slug: `renamed-${crypto.randomUUID()}`,
      data: {},
      _rev: renameRevision,
    },
    'PUT',
  );
  assert.equal(renamed.status, 200, await renamed.text());
  assert.equal((await publish('media_items', id)).status, 200);
  assert.equal(
    (await request(draftAsset.url, undefined, 'GET', false)).status,
    200,
    'Renamed media lost file access',
  );

  const nativeForm = new FormData();
  nativeForm.set(
    'file',
    new File([photo], 'native-photo.jpg', { type: 'image/jpeg' }),
  );
  const nativeUpload = await fetch(base + '/_emdash/api/media', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'X-EmDash-Request': '1' },
    body: nativeForm,
  });
  const nativeUploaded = z
    .object({
      data: z.object({
        item: z.object({
          id: z.string(),
          url: z.string(),
          width: z.number(),
          height: z.number(),
        }),
      }),
    })
    .parse(await nativeUpload.json()).data.item;
  assert.equal(nativeUpload.status, 201);
  assert.equal(
    (await request(nativeUploaded.url, undefined, 'GET', false)).status,
    404,
  );
  const nativePhoto = await request('/_emdash/api/content/media_items', {
    slug: `native-${crypto.randomUUID()}`,
    data: {
      ...metadata,
      title: 'Native photo',
      kind: 'photo',
      asset: { id: nativeUploaded.id },
      poster: { id: nativeUploaded.id },
    },
  });
  const nativePhotoId = item.parse(await nativePhoto.json()).data.item.id;
  assert.equal((await publish('media_items', nativePhotoId)).status, 200);
  const nativeMediaPath = `/media_items/${nativePhotoId}`;
  const nativeMediaLink = await request(
    nativeMediaPath,
    undefined,
    'GET',
    false,
  );
  assert.equal(nativeMediaLink.status, 301, 'CMS media link does not redirect');
  assert.equal(
    nativeMediaLink.headers.get('Location'),
    `/media/${nativePhotoId}`,
  );
  assert.equal(
    (await request(`/media/${nativePhotoId}`, undefined, 'GET', false)).status,
    200,
  );
  const nativePhotoRevision = item.parse(
    await (
      await request(`/_emdash/api/content/media_items/${nativePhotoId}`)
    ).json(),
  ).data._rev;
  const stagedPhoto = await request(
    `/_emdash/api/content/media_items/${nativePhotoId}`,
    {
      data: { title: 'Synthetic unpublished media title' },
      _rev: nativePhotoRevision,
    },
    'PUT',
  );
  assert.equal(stagedPhoto.status, 200);
  const mediaPreviewResponse = await request(
    `/_emdash/api/content/media_items/${nativePhotoId}/preview-url`,
    {},
  );
  assert.equal(mediaPreviewResponse.status, 200);
  const mediaPreviewPath = z
    .object({ data: z.object({ url: z.string() }) })
    .parse(await mediaPreviewResponse.json()).data.url;
  const mediaPreviewUrl = new URL(mediaPreviewPath, base);
  for (const path of [
    mediaPreviewPath,
    `/media/${nativePhotoId}${mediaPreviewUrl.search}`,
    `/gallery${mediaPreviewUrl.search}`,
    `/${mediaPreviewUrl.search}`,
  ]) {
    const anonymousPreview = await request(path, undefined, 'GET', false);
    assert.equal(
      anonymousPreview.status,
      404,
      'Anonymous media preview exposed staged edits',
    );
    assert.equal(
      anonymousPreview.headers.get('Cache-Control'),
      'private, no-store',
    );
  }
  const mediaPreviewRedirect = await request(mediaPreviewPath);
  assert.equal(mediaPreviewRedirect.status, 301);
  const privateMediaPath = mediaPreviewRedirect.headers.get('Location');
  assert.ok(privateMediaPath);
  for (const path of [privateMediaPath, `/gallery${mediaPreviewUrl.search}`]) {
    const ownerMediaPreview = await request(path);
    assert.equal(ownerMediaPreview.status, 200);
    const privateHtml = await ownerMediaPreview.text();
    assert.ok(privateHtml.includes('Synthetic unpublished media title'));
    assert.ok(!privateHtml.includes('data-feedback-id="newsletter-signup"'));
    assert.ok(privateHtml.includes('data-feedback-redact="true"'));
    assert.ok(privateHtml.includes('data-feedback-private="true"'));
    assert.ok(privateHtml.includes('name="robots" content="noindex"'));
    assert.equal(
      ownerMediaPreview.headers.get('Cache-Control'),
      'private, no-store',
    );
    assert.equal(
      ownerMediaPreview.headers.get('Cloudflare-CDN-Cache-Control'),
      'no-store',
    );
  }
  const publicPhotoHtml = await (
    await request(`/media/${nativePhotoId}`, undefined, 'GET', false)
  ).text();
  assertPublicSignups(publicPhotoHtml, `/media/${nativePhotoId}`);
  assert.ok(publicPhotoHtml.includes('Native photo'));
  assert.ok(!publicPhotoHtml.includes('Synthetic unpublished media title'));
  const incompleteMedia = await request('/_emdash/api/content/media_items', {
    slug: `incomplete-${crypto.randomUUID()}`,
    data: {
      ...metadata,
      title: 'Synthetic media without a kind',
      asset: { id: nativeUploaded.id },
    },
  });
  const incompleteMediaId = item.parse(await incompleteMedia.json()).data.item
    .id;
  assert.equal(
    (await publish('media_items', incompleteMediaId)).status,
    422,
    'Native CMS published media that disappears from the public UI',
  );
  assert.equal(
    (await request(nativeUploaded.url, undefined, 'GET', false)).status,
    200,
    'Native published media file denied',
  );

  const beerSaved = await request('/api/trip/beers', {
    day: '2099-10-15',
    count: 3,
  });
  assert.equal(beerSaved.status, 200, await beerSaved.text());
  assert.equal(
    (await request('/api/trip/beers', { day: '2099-10-15', count: 4 })).status,
    200,
  );
  const manifest = await request('/api/trip/story', {
    day: '2099-10-15',
    ids: [id],
    counter: 'total',
  });
  assert.equal(manifest.status, 200);
  const story = z
    .object({
      beers: z.object({ today: z.number() }),
      media: z.array(z.object({ id: z.string() })),
    })
    .parse(await manifest.json());
  assert.equal(story.beers.today, 4);
  assert.equal(story.media[0]?.id, id);
  assert.equal(
    (
      await request('/api/trip/story', {
        day: '2099-10-14',
        ids: [id],
        counter: 'total',
      })
    ).status,
    400,
  );
  // Exercise the same calendar through real newsletter, public and owner routes.
  const earlierBeer = item.parse(
    await (
      await request('/api/trip/beers', { day: '2099-10-14', count: 1 })
    ).json(),
  ).data.item.id;
  const dayPosts: {
    id: string;
    slug: string;
    title: string;
    expected: string;
  }[] = [];
  const numberingMediaBefore: unknown = await (
    await request(`/_emdash/api/content/media_items/${id}`)
  ).json();
  for (const fixture of [
    {
      day: '2099-10-15',
      title: 'day 2: sample arrival',
      expected: 'day 1: sample arrival',
    },
    {
      day: '2099-10-17',
      title: 'day 99: sample later',
      expected: 'day 3: sample later',
    },
  ]) {
    const slug = `sample-day-numbering-${crypto.randomUUID()}`;
    const created = item.parse(
      await (
        await request('/_emdash/api/content/posts', {
          slug,
          data: {
            title: fixture.title,
            day: fixture.day,
            gallery: [],
            content: [],
          },
        })
      ).json(),
    ).data.item.id;
    assert.equal((await publish('posts', created)).status, 200);
    dayPosts.push({
      id: created,
      slug,
      title: fixture.title,
      expected: fixture.expected,
    });
  }
  const numberedStory = await request('/api/trip/story', {
    day: '2099-10-15',
    ids: [id],
    counter: 'total',
  });
  assert.match(
    z.object({ title: z.string() }).parse(await numberedStory.json()).title,
    /^day 1: /,
  );
  const numberedHome = await (
    await request('/', undefined, 'GET', false)
  ).text();
  const numberedOwner = await (await request('/owner')).text();
  const numberedPreview = await request('/api/trip/newsletter-preview');
  assert.equal(numberedPreview.status, 200);
  const numberedEmail = await numberedPreview.text();
  for (const fixture of dayPosts) {
    assert.ok(numberedHome.includes(fixture.expected));
    assert.ok(numberedOwner.includes(fixture.expected));
    assert.ok(numberedEmail.includes(fixture.expected));
    assert.ok(!numberedEmail.includes(fixture.title));
    const detail = await (
      await request(`/posts/${fixture.slug}`, undefined, 'GET', false)
    ).text();
    assertPublicSignups(detail, `/posts/${fixture.slug}`);
    assert.ok(detail.includes(`<h1>${fixture.expected}</h1>`));
    const editor = z
      .object({ data: z.object({ title: z.string() }) })
      .parse(await (await request(`/api/trip/posts?id=${fixture.id}`)).json());
    assert.equal(editor.data.title, fixture.expected);
    const stored = item.parse(
      await (await request(`/_emdash/api/content/posts/${fixture.id}`)).json(),
    );
    assert.equal(stored.data.item.data.title, fixture.title);
    assert.equal(
      (
        await request(
          `/_emdash/api/content/posts/${fixture.id}`,
          undefined,
          'DELETE',
        )
      ).status,
      200,
    );
  }
  assert.deepEqual(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
    numberingMediaBefore,
  );
  assert.equal(
    (
      await request(
        `/_emdash/api/content/beers/${earlierBeer}`,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  console.log(
    'Shared day numbering passed across newsletter preview, blog, owner titles and story manifest without changing stored titles or captures.',
  );
  const post = await request('/_emdash/api/content/posts', {
    slug: `integration-${crypto.randomUUID()}`,
    data: {
      title: 'integration post',
      day: '2099-10-15',
      gallery: [id],
      content: [
        {
          _type: 'block',
          _key: 'p',
          style: 'normal',
          children: [
            {
              _type: 'span',
              _key: 's',
              text: 'Full post body verification',
              marks: [],
            },
          ],
          markDefs: [],
        },
      ],
    },
  });
  const postId = item.parse(await post.json()).data.item.id;
  const previewResponse = await request(
    `/_emdash/api/content/posts/${postId}/preview-url`,
    {},
  );
  assert.equal(previewResponse.status, 200);
  const previewPath = z
    .object({ data: z.object({ url: z.string() }) })
    .parse(await previewResponse.json()).data.url;
  const ownerPreview = await request(previewPath);
  assert.equal(
    ownerPreview.status,
    200,
    'Native owner draft preview is broken',
  );
  const previewHtml = await ownerPreview.text();
  assert.ok(!previewHtml.includes('data-feedback-id="newsletter-signup"'));
  assert.ok(previewHtml.includes('Full post body verification'));
  assert.ok(previewHtml.includes('class="post-mosaic"'));
  assert.ok(!previewHtml.includes('post-carousel'));
  assert.ok(previewHtml.includes('data-visibility-video'));
  assert.ok(!previewHtml.includes('/media-preview/'));
  assert.ok(previewHtml.includes('data-feedback-redact="true"'));
  assert.ok(previewHtml.includes('data-feedback-private="true"'));
  assert.ok(previewHtml.includes('name="robots" content="noindex"'));
  assert.equal(ownerPreview.headers.get('Cache-Control'), 'private, no-store');
  const invalidPreview = new URL(previewPath, base);
  invalidPreview.searchParams.set('_preview', 'invalid');
  assert.equal(
    (await request(invalidPreview.pathname + invalidPreview.search)).status,
    404,
    'Invalid preview token exposed an owner draft',
  );
  assert.equal(
    (await request(previewPath, undefined, 'GET', false)).status,
    404,
    'Preview token alone exposed an owner draft',
  );
  assert.equal(
    (await request(`/posts/${postId}`, undefined, 'GET', false)).status,
    404,
  );
  assert.equal((await publish('posts', postId)).status, 200);
  assert.equal(
    (await request(previewPath, undefined, 'GET', false)).status,
    404,
    'Anonymous preview may expose staged edits on a published post',
  );
  assert.equal(
    (await request(`/posts/${postId}`, undefined, 'GET', false)).status,
    200,
  );

  const nativeEditView = await request(`/api/trip/posts?id=${postId}`);
  assert.equal(nativeEditView.status, 200, await nativeEditView.text());

  const postRevision = item.parse(
    await (await request(`/_emdash/api/content/posts/${postId}`)).json(),
  ).data._rev;
  const unsafeEdit = await request('/api/trip/posts', {
    id: postId,
    revision: postRevision,
    title: 'Must not overwrite existing post',
    day: '2099-10-15',
    place: '',
    gallery: [],
    publish: false,
    document: {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Dinner' }],
                },
                {
                  type: 'image',
                  attrs: {
                    src: nativeUploaded.url,
                    mediaId: nativeUploaded.id,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(unsafeEdit.status, 400, await unsafeEdit.text());
  const unchanged = item.parse(
    await (await request(`/_emdash/api/content/posts/${postId}`)).json(),
  );
  assert.equal(unchanged.data._rev, postRevision);
  assert.equal(unchanged.data.item.data.title, 'integration post');
  const edited = await request('/api/trip/posts', {
    id: postId,
    revision: postRevision,
    title: 'integration post',
    day: '2099-10-15',
    place: 'tokyo',
    gallery: [id],
    publish: true,
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Full post body verification',
              marks: [{ type: 'bold' }],
            },
          ],
        },
        {
          type: 'paragraph',
        },
        {
          type: 'videoBlock',
          attrs: {
            src: draftAsset.url,
            mediaId: asset.id,
            provider: 'local',
          },
        },
        {
          type: 'image',
          attrs: {
            src: nativeUploaded.url,
            mediaId: nativeUploaded.id,
            provider: 'local',
            width: nativeUploaded.width,
            height: nativeUploaded.height,
            caption: 'Native image',
          },
        },
        {
          type: 'gallery',
          attrs: {
            columns: 2,
            images: [
              {
                _type: 'image',
                _key: 'native-photo',
                asset: { _ref: nativeUploaded.id, url: nativeUploaded.url },
                width: nativeUploaded.width,
                height: nativeUploaded.height,
                alt: 'Native gallery image',
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(edited.status, 200, await edited.text());
  const editView = await request(`/api/trip/posts?id=${postId}`);
  assert.equal(editView.status, 200);
  assert.ok(JSON.stringify(await editView.json()).includes('videoBlock'));

  const home = await (await request('/', undefined, 'GET', false)).text();
  assert.ok(home.includes('Full post body verification'));
  assert.ok(home.includes('Integration video'));
  assert.ok(home.includes('Native gallery image'));
  const gallery = await (
    await request('/gallery', undefined, 'GET', false)
  ).text();
  assert.ok(gallery.includes('aria-label="Media categories"'));
  assert.ok(gallery.includes('/gallery?category=food'));
  assert.ok(gallery.includes('/gallery?category=shopping'));
  assert.ok(!gallery.includes('/gallery?category=people'));
  assert.ok(
    !/src="[^"]*\/_image/.test(home),
    'Dimensioned content uses blocked image transforms',
  );
  assert.ok(
    (
      await (
        await request('/gallery?category=food', undefined, 'GET', false)
      ).text()
    ).includes('Integration video'),
  );
  const unpublishRevision = item.parse(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
  ).data._rev;
  assert.equal(
    (
      await request(`/_emdash/api/content/media_items/${id}/unpublish`, {
        _rev: unpublishRevision,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(draftAsset.url, undefined, 'GET', false)).status,
    404,
    'Unpublished media bytes exposed',
  );
  const rejected = await request('/api/trip/posts', {
    title: 'Rejected publish',
    day: '2099-10-15',
    place: '',
    gallery: [id],
    publish: true,
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  assert.equal(rejected.status, 200);
  const rejectedBody = z
    .object({
      post: z.object({
        id: z.string(),
        revision: z.string(),
        status: z.string(),
      }),
      publicationError: z.string(),
    })
    .parse(await rejected.json());
  assert.equal(rejectedBody.post.status, 'draft');
  const recovered = await request('/api/trip/posts', {
    id: rejectedBody.post.id,
    revision: rejectedBody.post.revision,
    title: 'Recovered draft',
    day: '2099-10-15',
    place: '',
    gallery: [],
    publish: false,
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  assert.equal(recovered.status, 200, await recovered.text());
  // All lifecycle operations use only this ephemeral D1/R2 fixture.
  const postPath = `/_emdash/api/content/posts/${postId}`;
  const beforeActions = item.parse(await (await request(postPath)).json());
  const mediaBeforeActions: unknown = await (
    await request(`/_emdash/api/content/media_items/${id}`)
  ).json();
  const historyBefore: unknown = await (
    await request(`${postPath}/revisions`)
  ).json();
  const mutationRequests = [
    { path: `${postPath}/unpublish`, method: 'POST' },
    { path: postPath, method: 'DELETE' },
  ];
  for (const { path, method } of mutationRequests) {
    assert.equal((await request(path, {}, method, false)).status, 401);
    for (const headers of [
      new Headers({ Cookie: cookie, Origin: base }),
      new Headers({ Cookie: cookie, 'X-EmDash-Request': '1' }),
      new Headers({
        Cookie: cookie,
        'X-EmDash-Request': '1',
        Origin: 'https://example.invalid',
      }),
    ]) {
      assert.equal((await fetch(base + path, { method, headers })).status, 403);
    }
  }
  assert.ok(
    (await request(`${postPath}/unpublish`, undefined, 'GET')).status >= 400,
  );
  assert.equal(
    item.parse(await (await request(postPath)).json()).data._rev,
    beforeActions.data._rev,
  );
  for (const badId of [
    "' OR 1=1 --",
    'invalid',
    'posts',
    '01M4AAAAAAAAAAAAAAAAAAAAAA;DROP',
  ]) {
    const path = `/_emdash/api/content/posts/${encodeURIComponent(badId)}`;
    assert.equal((await request(`${path}/unpublish`, {}, 'POST')).status, 400);
    assert.equal((await request(path, undefined, 'DELETE')).status, 400);
  }
  const unpublished = await request(`${postPath}/unpublish`, {
    _rev: beforeActions.data._rev,
  });
  assert.equal(unpublished.status, 200, await unpublished.text());
  const draft = item.parse(await (await request(postPath)).json());
  assert.deepEqual(draft.data.item.data, beforeActions.data.item.data);
  const publicPost = await request(`/posts/${postId}`, undefined, 'GET', false);
  assert.equal(publicPost.status, 404);
  assert.match(publicPost.headers.get('Cache-Control') || '', /no-store/);
  const afterHome = await request('/', undefined, 'GET', false);
  assert.match(afterHome.headers.get('Cache-Control') || '', /no-store/);
  assert.ok(!(await afterHome.text()).includes('Full post body verification'));
  assert.equal((await request(`/api/trip/posts?id=${postId}`)).status, 200);
  assert.equal(
    (
      await request(`${postPath}/unpublish`, {
        _rev: beforeActions.data._rev,
      })
    ).status,
    409,
  );
  const scheduled = await request(`${postPath}/schedule`, {
    _rev: draft.data._rev,
    scheduledAt: '2099-10-16T12:00:00Z',
  });
  assert.equal(scheduled.status, 200, await scheduled.text());
  const scheduledPost = item.parse(await (await request(postPath)).json());
  assert.equal(
    (
      await request(`${postPath}/unpublish`, {
        _rev: scheduledPost.data._rev,
      })
    ).status,
    200,
  );
  const unscheduled = z
    .object({
      data: z.object({
        item: z.object({
          status: z.string(),
          scheduledAt: z.null(),
          draftRevisionId: z.string(),
        }),
      }),
    })
    .parse(await (await request(postPath)).json());
  assert.equal(unscheduled.data.item.status, 'draft');
  const revisionsAfter = JSON.stringify(
    await (await request(`${postPath}/revisions`)).json(),
  );
  const historyIds = z
    .object({
      data: z.object({ items: z.array(z.object({ id: z.string() })) }),
    })
    .parse(historyBefore).data.items;
  for (const revision of historyIds)
    assert.ok(revisionsAfter.includes(revision.id));
  const deletedPost = await request(postPath, undefined, 'DELETE');
  assert.equal(deletedPost.status, 200, await deletedPost.text());
  assert.equal((await request(postPath)).status, 404);
  assert.equal(
    (await request(`/posts/${postId}`, undefined, 'GET', false)).status,
    404,
  );
  const trash = await request('/_emdash/api/content/posts/trash');
  assert.ok(JSON.stringify(await trash.json()).includes(postId));
  assert.deepEqual(
    await (await request(`/_emdash/api/content/media_items/${id}`)).json(),
    mediaBeforeActions,
  );
  assert.equal(
    (await request(`/_emdash/api/media/asset/${draftAsset.id}/video.mp4`))
      .status,
    200,
  );
  assert.equal(
    (await request(nativeUploaded.url, undefined, 'GET', false)).status,
    200,
  );
  assert.equal(
    (await request(`/api/trip/posts?id=${rejectedBody.post.id}`)).status,
    200,
  );
  const deletionFixture = item.parse(
    await (
      await request('/_emdash/api/content/posts', {
        slug: `synthetic-deletion-${crypto.randomUUID()}`,
        data: {
          title: 'Synthetic published deletion',
          day: '2099-10-15',
          gallery: [],
          content: [],
        },
      })
    ).json(),
  ).data.item.id;
  assert.equal((await publish('posts', deletionFixture)).status, 200);
  assert.equal(
    (await request(`/posts/${deletionFixture}`, undefined, 'GET', false))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        `/_emdash/api/content/posts/${deletionFixture}`,
        undefined,
        'DELETE',
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/posts/${deletionFixture}`, undefined, 'GET', false))
      .status,
    404,
  );

  console.log(
    'Synthetic post lifecycle passed: owner/anonymous, CSRF, malicious IDs, public 404/no-store, drafts/history/schedule, CMS trash and unchanged media/other posts.',
  );

  await request(`/_emdash/api/content/media_items/${id}`, undefined, 'DELETE');
  console.log(
    'Full flow passed: owner auth, CSRF, original privacy, R2 upload/ranges, GPS publication, categories, beer revisions, day exports and rich-text publication.',
  );
  await runBrowserContracts(transport);
}
try {
  await run();
  console.log(
    JSON.stringify({
      phase: 'integration-complete',
      elapsedMs: Date.now() - started,
    }),
  );
} finally {
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      )
        throw error;
    }
  }
}
