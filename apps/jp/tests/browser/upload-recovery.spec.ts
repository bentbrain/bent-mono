import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';

test('detailed portrait video uploads below the preview size limit with its original intact', async ({
  page,
}) => {
  await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async (path) => {
    await import(path);
  }, '/src/lib/prepare-media.ts');
  let uploadBody: Buffer | undefined;
  let uploadHeaders: Record<string, string> = {};
  await page.route('**/api/trip/upload', async (route) => {
    uploadBody = route.request().postDataBuffer() ?? undefined;
    uploadHeaders = route.request().headers();
    await route.continue();
  });
  const uploaded = page.waitForResponse((response) =>
    response.url().endsWith('/api/trip/upload'),
  );
  const originalHash = await page.evaluate(async (path) => {
    await import(path);
    const input = document.querySelector('#upload');
    if (!(input instanceof HTMLInputElement) || !input.dataset.originalHash)
      throw new Error('synthetic original hash unavailable');
    return input.dataset.originalHash;
  }, '/tests/fixtures/portrait-upload.ts');
  const response = await uploaded;
  expect(response.status()).toBe(201);
  const request = response.request();
  const body = uploadBody;
  if (!body) throw new Error('upload body unavailable');
  const form = await new Request(request.url(), {
    method: 'POST',
    headers: uploadHeaders,
    body: new Uint8Array(body),
  }).formData();
  const original = form.get('original');
  const display = form.get('display');
  expect(original).toBeInstanceOf(File);
  expect(display).toBeInstanceOf(File);
  if (!(original instanceof File) || !(display instanceof File))
    throw new Error('upload files unavailable');
  expect(
    createHash('sha256')
      .update(new Uint8Array(await original.arrayBuffer()))
      .digest('hex'),
  ).toBe(originalHash);
  expect(display.type).toBe('video/mp4');
  const input = new Input({
    source: new BlobSource(display),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('converted video track unavailable');
    expect(await track.getDisplayWidth()).toBe(360);
    expect(await track.getDisplayHeight()).toBe(640);
    expect(await input.computeDuration()).toBeCloseTo(305 / 30, 2);
  } finally {
    input.dispose();
  }

  expect(display.size).toBeLessThan(32 * 1024 * 1024);
  await expect(page.locator('#upload-status')).toHaveText('uploaded');
  await expect(
    page.getByRole('button', {
      name: 'sample bitrate.mov, draft',
      exact: true,
    }),
  ).toBeVisible();
});

test('a stalled MOV times out, later photos upload, and retry sends only the failed file', async ({
  page,
}) => {
  await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('/deps/mediabunny.js')),
    ),
  ).toBe(false);
  // Load the optional upload code explicitly for this fault-injection test.
  await page.evaluate(async (path) => {
    await import(path);
  }, '/src/lib/prepare-media.ts');
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/deps/mediabunny.js'));
    if (!resource) throw new Error('video module not loaded');
    // Stall the real preparation path once. Retry uses the original parser.
    const module: unknown = await import(resource.name);
    if (!module || typeof module !== 'object')
      throw new Error('video module unavailable');
    const input: unknown = Reflect.get(module, 'Input');
    if (typeof input !== 'function') throw new Error('video input unavailable');
    const prototype: unknown = Reflect.get(input, 'prototype');
    if (!prototype || typeof prototype !== 'object')
      throw new Error('video prototype unavailable');
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      'computeDuration',
    );
    if (!original) throw new Error('duration reader not found');
    Object.defineProperty(prototype, 'computeDuration', {
      configurable: true,
      value() {
        Object.defineProperty(prototype, 'computeDuration', original);
        return new Promise(() => {});
      },
    });
  });
  await page.clock.install();
  // 305 frames at 30fps preserves a complete nominal ten-second capture.
  const video = await readFile('tests/fixtures/frame-timed-video.mp4');
  const photo = await readFile('public/demo/japan.jpg');
  let libraryLoads = 0;
  let uploads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/trip/media')) libraryLoads++;
    if (request.url().endsWith('/api/trip/upload')) uploads++;
  });
  await page.locator('#upload').setInputFiles([
    { name: 'sample stalled.mov', mimeType: 'video/quicktime', buffer: video },
    { name: 'sample later.jpg', mimeType: 'image/jpeg', buffer: photo },
  ]);
  await expect(page.locator('#upload-status')).toHaveText(
    '1 / 2 reading video: sample stalled.mov',
  );
  await page.clock.fastForward(120_001);
  await page.clock.resume();
  await expect(page.locator('#upload-status')).toHaveText(
    '1 uploaded; 1 failed',
  );
  await expect(page.locator('#upload-errors')).toContainText(
    'sample stalled.mov: reading video timed out',
  );
  await expect(
    page.getByRole('button', { name: 'sample later.jpg, draft', exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  expect(libraryLoads).toBe(1);
  await page
    .getByRole('button', { name: 'RETRY FAILED FILES', exact: true })
    .click();
  await expect(page.locator('#upload-status')).toHaveText('uploaded', {
    timeout: 30_000,
  });
  await expect(page.locator('#upload-errors')).toHaveCount(0);
  expect(uploads).toBe(2);
  await expect(
    page.getByRole('button', { name: 'sample later.jpg, draft', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', {
      name: 'sample stalled.mov, draft',
      exact: true,
    }),
  ).toBeVisible();
});

test('a lost upload response does not block later files or offer a blind retry', async ({
  page,
}) => {
  await page.goto('/_emdash/api/setup/dev-bypass?redirect=/owner/media');
  await page.waitForURL('**/owner/media');
  await expect(
    page.getByRole('button', { name: 'UPLOAD', exact: true }),
  ).toBeEnabled();
  let uploads = 0;
  await page.route('**/api/trip/upload', async (route) => {
    uploads++;
    if (uploads === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('connectionreset');
    } else await route.continue();
  });
  const photo = await readFile('public/demo/japan.jpg');
  await page.locator('#upload').setInputFiles([
    { name: 'sample lost response.jpg', mimeType: 'image/jpeg', buffer: photo },
    {
      name: 'sample after response.jpg',
      mimeType: 'image/jpeg',
      buffer: photo,
    },
  ]);
  await expect(page.locator('#upload-status')).toHaveText(
    '1 uploaded; 1 failed',
  );
  await expect(page.locator('#upload-errors')).toContainText(
    'could not confirm upload',
  );
  await expect(
    page.getByRole('button', { name: 'RETRY FAILED FILES', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'sample lost response.jpg, draft',
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', {
      name: 'sample after response.jpg, draft',
      exact: true,
    }),
  ).toHaveCount(1);
  expect(uploads).toBe(2);
});
