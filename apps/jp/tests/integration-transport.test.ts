import assert from 'node:assert/strict';
import test from 'node:test';
import { drainDeniedRequest } from '../scripts/integration-transport';
import {
  assertStatus,
  isDevProxyDispatchError,
  serverSignals,
} from '../scripts/integration-diagnostics';

void test('rejected synthetic body is consumed without changing the denial', async () => {
  const request = new Request('http://localhost/example', {
    method: 'POST',
    body: JSON.stringify({ category: 'synthetic fixture' }),
  });
  const response = Response.json(
    { error: 'Request rejected' },
    { status: 403 },
  );
  assert.equal(await drainDeniedRequest(request, response), response);
  assert.equal(request.bodyUsed, true);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Request rejected' });
});

void test('transport leaves successful mutations, genuine errors and read bodies alone', async () => {
  for (const status of [200, 201, 500, 503]) {
    const request = new Request('http://localhost/example', {
      method: 'POST',
      body: 'synthetic fixture',
    });
    const response = new Response('result', { status });
    assert.equal(await drainDeniedRequest(request, response), response);
    assert.equal(request.bodyUsed, false);
  }
  const read = new Request('http://localhost/example', {
    method: 'POST',
    body: 'synthetic fixture',
  });
  await read.text();
  const denial = new Response(null, { status: 401 });
  assert.equal(await drainDeniedRequest(read, denial), denial);
  assert.equal(
    await drainDeniedRequest(new Request('http://localhost/example'), denial),
    denial,
  );
});

function streamedRequest(body: ReadableStream<Uint8Array>) {
  // Node's streamed fetch requires duplex; the DOM RequestInit omits it.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    body,
    duplex: 'half',
  };
  return new Request('http://localhost/example', init);
}

void test('oversized and stalled synthetic rejection bodies fail with bounded cleanup', async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  const request = streamedRequest(stream);
  await assert.rejects(
    drainDeniedRequest(request, new Response(null, { status: 403 })),
    /exceeds transport limit/,
  );
  assert.equal(canceled, true);
  const stalled = streamedRequest(new ReadableStream<Uint8Array>());
  await assert.rejects(
    drainDeniedRequest(stalled, new Response(null, { status: 403 })),
    /timed out/,
  );
});

const overlay = `<!DOCTYPE html><script>const error = ${JSON.stringify({
  message: 'fetch failed',
  stack: 'at _Miniflare.dispatchFetch at @cloudflare/vite-plugin',
  secret: 'private-cookie-value',
})}\n</script>`;

void test('diagnostics recognize the specific proxy overlay without accepting application errors', () => {
  assert.equal(isDevProxyDispatchError(500, '', overlay), true);
  assert.equal(isDevProxyDispatchError(500, 'text/html', overlay), true);
  for (const { status, type, body } of [
    { status: 403, type: 'text/html', body: overlay },
    { status: 500, type: 'application/json', body: overlay },
    {
      status: 500,
      type: 'text/html',
      body: 'fetch failed at _Miniflare.dispatchFetch',
    },
    {
      status: 500,
      type: 'text/html',
      body: '<script>const error = {invalid}\n</script>',
    },
    {
      status: 500,
      type: 'text/html',
      body: overlay.replace('fetch failed', 'D1_ERROR'),
    },
  ])
    assert.equal(isDevProxyDispatchError(status, type, body), false);
});

void test('unexpected statuses always fail and diagnostics omit private output', async () => {
  for (const body of [overlay, 'D1_ERROR private-cookie-value']) {
    await assert.rejects(
      assertStatus(
        new Response(body, {
          status: 500,
          headers: { 'Set-Cookie': 'private-cookie-value' },
        }),
        403,
        'synthetic denial',
        [{ atMs: 42, signals: serverSignals('D1_ERROR private-cookie-value') }],
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"expected":403,"actual":500/);
        assert.ok(!error.message.includes('private-cookie-value'));
        return true;
      },
    );
  }
  await assertStatus(new Response(null, { status: 403 }), 403, 'denial', []);
});
