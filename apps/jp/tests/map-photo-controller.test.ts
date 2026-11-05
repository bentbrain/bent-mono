import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { resolveMapPhoto } from '../src/lib/map-photo-controller';
import { mapPhoto } from '../src/lib/responsive-image';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const poster = '/_emdash/api/media/file/trip/synthetic/photo.jpg';
const portrait = { width: 1200, height: 1600 };
const landscape = { width: 1600, height: 1200 };

for (const seam of ['headers', 'body']) {
  for (const lateAt of ['before retry', 'after retry']) {
    void test(`map controller deadline covers held ${seam} and ignores late completion ${lateAt}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const headers = deferred<Response>();
      let finishBody: () => void = () => {
        throw new Error('Body not initialized');
      };
      const response = new Response(
        new ReadableStream({
          start(controller) {
            finishBody = () => {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(landscape)),
              );
              controller.close();
            };
          },
        }),
      );
      const photos: ReturnType<typeof mapPhoto>[] = [];
      let failures = 0;
      let signal: AbortSignal | null | undefined;
      const stop = resolveMapPhoto({
        url: '/map-photo/synthetic/portrait',
        poster,
        ready: (photo) => {
          photos.push(photo);
        },
        failed: () => {
          failures++;
        },
        request: (_url, init) => {
          signal = init.signal;
          assert.equal(init.cache, 'no-store');
          return seam === 'headers'
            ? headers.promise
            : Promise.resolve(response);
        },
      });
      t.mock.timers.tick(60);
      await setImmediate();
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      assert.equal(photos.length, 0);
      t.mock.timers.tick(7940);
      assert.equal(signal.aborted, true);
      assert.equal(failures, 1);
      assert.equal(photos.length, 0);
      const finishLate = async () => {
        if (seam === 'headers') headers.resolve(Response.json(landscape));
        else finishBody();
        await setImmediate();
      };
      if (lateAt === 'before retry') {
        await finishLate();
        assert.equal(failures, 1);
        assert.equal(photos.length, 0);
      }
      stop();
      const stopRetry = resolveMapPhoto({
        url: '/map-photo/synthetic/portrait',
        poster,
        ready: (photo) => {
          photos.push(photo);
        },
        failed: () => {
          failures++;
        },
        request: () => Promise.resolve(Response.json(portrait)),
      });
      t.mock.timers.tick(60);
      await setImmediate();
      assert.deepEqual(photos, [mapPhoto(poster, portrait)]);
      if (lateAt === 'after retry') await finishLate();
      assert.deepEqual(photos, [mapPhoto(poster, portrait)]);
      t.mock.timers.tick(10000);
      assert.equal(failures, 1);
      stopRetry();
    });
  }
}

for (const action of ['selection', 'close', 'unmount']) {
  void test(`map controller invalidates streaming body on ${action}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish: () => void = () => {
      throw new Error('Body not initialized');
    };
    const response = new Response(
      new ReadableStream({
        start(controller) {
          finish = () => {
            controller.enqueue(
              new TextEncoder().encode('{"width":1,"height":1000}'),
            );
            controller.close();
          };
        },
      }),
    );
    const photos: ReturnType<typeof mapPhoto>[] = [];
    let failures = 0;
    let signal: AbortSignal | null | undefined;
    const options = {
      url: '/map-photo/synthetic/portrait',
      poster,
      ready: (photo: ReturnType<typeof mapPhoto>) => {
        photos.push(photo);
      },
      failed: () => {
        failures++;
      },
    };
    const stop = resolveMapPhoto({
      ...options,
      request: (_url, init) => {
        signal = init.signal;
        return Promise.resolve(response);
      },
    });
    t.mock.timers.tick(60);
    await setImmediate();
    stop();
    assert.ok(signal?.aborted);
    const stopSelection =
      action === 'selection'
        ? resolveMapPhoto({
            ...options,
            request: () => Promise.resolve(Response.json(landscape)),
          })
        : undefined;
    finish();
    t.mock.timers.tick(60);
    await setImmediate();
    assert.deepEqual(
      photos,
      action === 'selection' ? [mapPhoto(poster, landscape)] : [],
    );
    t.mock.timers.tick(10000);
    assert.equal(failures, 0);
    stopSelection?.();
  });
}

void test('map controller coalesces cancelled selections and retries a failed response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  let failures = 0;
  const photos: ReturnType<typeof mapPhoto>[] = [];
  const options = {
    url: '/map-photo/synthetic/portrait',
    poster,
    ready: (photo: ReturnType<typeof mapPhoto>) => {
      photos.push(photo);
    },
    failed: () => {
      failures++;
    },
    request: () => {
      requests++;
      return Promise.resolve(
        requests === 1
          ? new Response(null, { status: 503 })
          : Response.json(portrait),
      );
    },
  };
  resolveMapPhoto(options)();
  t.mock.timers.tick(10000);
  assert.equal(requests, 0);
  const stop = resolveMapPhoto(options);
  t.mock.timers.tick(60);
  await setImmediate();
  assert.equal(requests, 1);
  assert.equal(failures, 1);
  assert.equal(photos.length, 0);
  stop();
  const stopRetry = resolveMapPhoto(options);
  t.mock.timers.tick(60);
  await setImmediate();
  assert.equal(requests, 2);
  assert.deepEqual(photos, [mapPhoto(poster, portrait)]);
  stopRetry();
});

for (const value of [
  null,
  { width: 0, height: 10 },
  { width: 10.5, height: 20 },
  { width: '10', height: 20 },
  {},
  'bad',
]) {
  void test(`map controller validates dimensions ${JSON.stringify(value)}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const photos: ReturnType<typeof mapPhoto>[] = [];
    let failures = 0;
    const stop = resolveMapPhoto({
      url: '/map-photo/synthetic/portrait',
      poster,
      ready: (photo) => {
        photos.push(photo);
      },
      failed: () => {
        failures++;
      },
      request: () => Promise.resolve(Response.json(value)),
    });
    t.mock.timers.tick(60);
    await setImmediate();
    assert.equal(failures, value === null ? 0 : 1);
    assert.deepEqual(photos, value === null ? [mapPhoto(poster)] : []);
    stop();
  });
}
