import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedPostImage } from '../src/lib/saved-post-image';

const source = 'https://93.184.216.34/synthetic.png';
const input = {
  id: '01K00000000000000000000000',
  revision: 'revision-one',
  source,
};
const getPost = () =>
  Promise.resolve({
    success: true,
    data: {
      _rev: input.revision,
      item: {
        data: { content: [{ _type: 'image', asset: { _ref: source } }] },
      },
    },
  });

void test('saved image source requires the exact saved revision and image reference', async () => {
  let reads = 0;
  const read = () => {
    reads++;
    return Promise.resolve(
      new Response('synthetic', { headers: { 'Content-Type': 'image/png' } }),
    );
  };
  for (const changed of [
    { ...input, revision: 'stale' },
    { ...input, source: 'https://93.184.216.34/unrelated.png' },
  ]) {
    const response = await savedPostImage(
      changed,
      'https://jp.bent.build',
      getPost,
      read,
    );
    assert.ok(response.status >= 400);
  }
  assert.equal(reads, 0);
  const response = await savedPostImage(
    input,
    'https://jp.bent.build',
    getPost,
    read,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'synthetic');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

void test('video references cannot authorize an image import', async () => {
  const post = await getPost();
  post.data.item.data.content[0] = { _type: 'video', asset: { _ref: source } };
  const response = await savedPostImage(
    input,
    'https://jp.bent.build',
    () => Promise.resolve(post),
    () => {
      throw new Error('must not fetch');
    },
  );
  assert.equal(response.status, 400);
});

void test('image imports reject non-public addresses, credential URLs and same-site sources before fetching', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('must not fetch');
  });
  for (const rejected of [
    'https://127.0.0.1/private.png',
    'https://[::1]/private.png',
    'https://169.254.169.254/private.png',
    'https://localhost/private.png',
    'https://jp.bent.build/private.png',
    'http://93.184.216.34/image.png',
    'https://user:password@93.184.216.34/image.png',
  ]) {
    const post = await getPost();
    post.data.item.data.content[0] = {
      _type: 'image',
      asset: { _ref: rejected },
    };
    const response = await savedPostImage(
      { ...input, source: rejected },
      'https://jp.bent.build',
      () => Promise.resolve(post),
    );
    assert.ok(response.status >= 400);
    assert.ok(!(await response.text()).includes(rejected));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

void test('source fetches strip credentials, block cross-host redirects and bound response bytes', async (t) => {
  let mode = 'redirect';
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers, undefined);
      return Promise.resolve(
        mode === 'redirect'
          ? new Response(null, {
              status: 302,
              headers: { Location: 'https://127.0.0.1/private.png' },
            })
          : new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
              headers: { 'Content-Type': 'image/png' },
            }),
      );
    },
  );
  assert.equal(
    (await savedPostImage(input, 'https://jp.bent.build', getPost)).status,
    422,
  );
  assert.equal(fetch.mock.callCount(), 1);
  mode = 'oversize';
  assert.equal(
    (await savedPostImage(input, 'https://jp.bent.build', getPost)).status,
    422,
  );
});

void test('non-image responses fail without returning upstream details', async () => {
  const response = await savedPostImage(
    input,
    'https://jp.bent.build',
    getPost,
    () =>
      Promise.resolve(
        new Response('private upstream error', {
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
  );
  assert.equal(response.status, 422);
  assert.ok(!(await response.text()).includes('private upstream error'));
});

void test('every redirect remains HTTPS on the original host without credentials or custom ports', async (t) => {
  let destination = '';
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request) => {
    calls.push(
      typeof url === 'string'
        ? url
        : url instanceof Request
          ? url.url
          : url.href,
    );
    return Promise.resolve(
      calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { Location: destination },
          })
        : new Response('synthetic', {
            headers: { 'Content-Type': 'image/png' },
          }),
    );
  });
  for (destination of [
    'http://93.184.216.34/image.png',
    'https://93.184.216.34:8443/image.png',
    'https://user:password@93.184.216.34/image.png',
    'https://93.184.216.35/image.png',
  ]) {
    calls.length = 0;
    const response = await savedPostImage(
      input,
      'https://jp.bent.build',
      getPost,
    );
    assert.equal(response.status, 422, destination);
    assert.deepEqual(calls, [source]);
  }
  destination = '/redirected.png';
  calls.length = 0;
  const response = await savedPostImage(
    input,
    'https://jp.bent.build',
    getPost,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'synthetic');
  assert.deepEqual(calls, [source, 'https://93.184.216.34/redirected.png']);
});

void test('historical image recovery requires a verified same-post snapshot and a fresh current token', async () => {
  const revisionId = '01K00000000000000000000001';
  let reads = 0;
  let historyReads = 0;
  const current = async () => {
    const post = await getPost();
    post.data.item.data.content = [];
    return post;
  };
  const snapshot = {
    success: true,
    data: {
      item: {
        id: revisionId,
        collection: 'posts',
        entryId: input.id,
        data: { content: [{ _type: 'image', asset: { _ref: source } }] },
      },
    },
  };
  const history = () => {
    historyReads++;
    return Promise.resolve(snapshot);
  };
  const read = () => {
    reads++;
    return Promise.resolve(
      new Response('synthetic', { headers: { 'Content-Type': 'image/png' } }),
    );
  };
  const request = { ...input, sourceRevision: revisionId };
  assert.equal(
    (
      await savedPostImage(
        { ...request, revision: 'stale' },
        'https://jp.bent.build',
        current,
        read,
        history,
      )
    ).status,
    409,
  );
  assert.equal(historyReads, 0);
  assert.equal(
    (
      await savedPostImage(
        request,
        'https://jp.bent.build',
        current,
        read,
        history,
      )
    ).status,
    200,
  );
  assert.equal(reads, 1);
  for (const item of [
    { ...snapshot.data.item, entryId: '01K00000000000000000000002' },
    { ...snapshot.data.item, collection: 'media_items' },
    { ...snapshot.data.item, id: '01K00000000000000000000003' },
    {
      ...snapshot.data.item,
      data: { content: [{ _type: 'video', asset: { _ref: source } }] },
    },
    { ...snapshot.data.item, data: { content: [] } },
  ]) {
    const result = await savedPostImage(
      request,
      'https://jp.bent.build',
      current,
      read,
      () => Promise.resolve({ success: true, data: { item } }),
    );
    assert.equal(result.status, 400);
  }
  assert.equal(
    (
      await savedPostImage(
        { ...request, source: 'https://93.184.216.34/invented.png' },
        'https://jp.bent.build',
        current,
        read,
        history,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await savedPostImage(
        request,
        'https://jp.bent.build',
        current,
        read,
        () => Promise.resolve({ success: false, error: { code: 'NOT_FOUND' } }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await savedPostImage(request, 'https://jp.bent.build', current, read))
      .status,
    400,
  );
  assert.equal(
    (
      await savedPostImage(
        input,
        'https://jp.bent.build',
        current,
        read,
        history,
      )
    ).status,
    400,
  );
  assert.equal(reads, 1, 'unauthorized history never acquires bytes');
});
