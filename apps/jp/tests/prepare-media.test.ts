import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { Conversion, Input } from 'mediabunny';
import { prepareMedia } from '../src/lib/prepare-media';

const sampleVideo = await readFile(
  new URL('./fixtures/frame-timed-video.mp4', import.meta.url),
);

function mockDocument(
  t: TestContext,
  createElement: (tag: string) => object = () => ({ getContext: () => ({}) }),
) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement },
  });
  t.after(() => {
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

void test('a video stuck reading its duration times out and releases its input', async (t) => {
  mockDocument(t);
  t.mock.method(
    Input.prototype,
    'computeDuration',
    () => new Promise<number>(() => {}),
  );
  const dispose = t.mock.method(Input.prototype, 'dispose', () => {});
  let outcome = 'pending';
  void prepareMedia(
    new File([sampleVideo], 'sample stalled.mov', { type: 'video/quicktime' }),
  ).then(
    () => {
      outcome = 'prepared';
    },
    () => {
      outcome = 'failed';
    },
  );
  await setImmediate();
  t.mock.timers.tick(120_001);
  await setImmediate();
  assert.equal(outcome, 'failed', 'video preparation must not wait forever');
  assert.equal(dispose.mock.callCount(), 1);
});

void test('conversion initialization finishing after timeout is cancelled', async (t) => {
  mockDocument(t);
  t.mock.method(Input.prototype, 'computeDuration', () => Promise.resolve(1));
  const dispose = t.mock.method(Input.prototype, 'dispose', () => {});
  let cancellations = 0;
  const conversion = {
    cancel: () => {
      cancellations++;
      return Promise.resolve();
    },
  };
  let finish: ((value: typeof conversion) => void) | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(Conversion, 'init');
  Object.defineProperty(Conversion, 'init', {
    configurable: true,
    value: () =>
      new Promise<typeof conversion>((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(Conversion, 'init', descriptor);
  });
  const prepared = prepareMedia(
    new File([sampleVideo], 'sample late.mov', { type: 'video/quicktime' }),
  );
  const rejected = assert.rejects(
    prepared,
    /preparing video conversion timed out/,
  );
  await setImmediate();
  t.mock.timers.tick(120_001);
  await rejected;
  assert.equal(dispose.mock.callCount(), 1);
  assert.ok(finish);
  finish(conversion);
  await setImmediate();
  assert.equal(cancellations, 1);
});

void test('a stalled conversion is cancelled without waiting for cancellation to finish', async (t) => {
  mockDocument(t);
  t.mock.method(Input.prototype, 'computeDuration', () => Promise.resolve(1));
  const dispose = t.mock.method(Input.prototype, 'dispose', () => {});
  let cancellations = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Conversion, 'init');
  Object.defineProperty(Conversion, 'init', {
    configurable: true,
    value: () =>
      Promise.resolve({
        isValid: true,
        execute: () => new Promise<void>(() => {}),
        cancel: () => {
          cancellations++;
          return new Promise<void>(() => {});
        },
      }),
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(Conversion, 'init', descriptor);
  });
  const rejected = assert.rejects(
    prepareMedia(
      new File([sampleVideo], 'sample conversion.mov', {
        type: 'video/quicktime',
      }),
    ),
    /converting video 0% timed out/,
  );
  await setImmediate();
  t.mock.timers.tick(120_001);
  await rejected;
  assert.equal(cancellations, 1);
  assert.equal(dispose.mock.callCount(), 1);
});

void test('a stalled SVG decode times out and releases its private object URL', async (t) => {
  let removed = 0;
  mockDocument(t, (tag) =>
    tag === 'canvas'
      ? { getContext: () => ({}) }
      : {
          decode: () => new Promise<void>(() => {}),
          removeAttribute: () => {
            removed++;
          },
        },
  );
  t.mock.method(URL, 'createObjectURL', () => 'blob:synthetic-svg');
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const rejected = assert.rejects(
    prepareMedia(new File(['<svg/>'], 'sample.svg', { type: 'image/svg+xml' })),
    /timed out/,
  );
  await setImmediate();
  t.mock.timers.tick(120_001);
  await rejected;
  assert.equal(removed, 1);
  assert.equal(revoke.mock.callCount(), 1);
  assert.equal(revoke.mock.calls[0]?.arguments[0], 'blob:synthetic-svg');
});
