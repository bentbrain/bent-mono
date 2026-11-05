import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { encode } from 'fast-png';

const created = z.object({
  data: z.object({ item: z.object({ id: z.string() }) }),
});

test('an existing URL image is imported before republishing without weakening media eligibility', async ({
  page,
  browser,
}) => {
  await page.request.post('/_emdash/api/setup/dev-bypass', {
    headers: { 'X-EmDash-Request': '1' },
    data: {},
  });
  await page.route('https://toolbar.bent.build/embed.js', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
  const result = await page.request.post('/_emdash/api/content/posts', {
    headers: { 'X-EmDash-Request': '1', Origin: 'http://127.0.0.1:4391' },
    data: {
      slug: 'synthetic-legacy-image',
      data: {
        title: 'Synthetic legacy image',
        day: '2026-10-15',
        gallery: [],
        content: [
          {
            _type: 'block',
            _key: 'paragraph',
            style: 'normal',
            children: [
              {
                _type: 'span',
                _key: 'text',
                text: 'Synthetic saved story',
                marks: [],
              },
            ],
            markDefs: [],
          },
          {
            _type: 'image',
            _key: 'legacy-image',
            asset: { _ref: 'https://legacy.example.invalid/synthetic.png' },
            alt: 'Synthetic saved image',
          },
          {
            _type: 'image',
            _key: 'legacy-image-two',
            asset: { _ref: 'https://legacy.example.invalid/second.png' },
            alt: 'Second synthetic saved image',
          },
        ],
      },
    },
  });
  expect(result.status()).toBe(201);
  const id = created.parse(await result.json()).data.item.id;
  const saved = z
    .object({ revision: z.string() })
    .parse(await (await page.request.get(`/api/trip/posts?id=${id}`)).json());
  const headers = { 'X-EmDash-Request': '1', Origin: 'http://127.0.0.1:4391' };
  const sourceInput = {
    id,
    revision: saved.revision,
    source: 'https://legacy.example.invalid/synthetic.png',
  };
  expect(
    (
      await page.request.post('/api/trip/post-image-source', {
        data: sourceInput,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post('/api/trip/post-image-source', {
        headers,
        data: { ...sourceInput, revision: 'stale' },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.post('/api/trip/post-image-source', {
        headers,
        data: {
          ...sourceInput,
          source: 'https://unrelated.example.invalid/other.png',
        },
      })
    ).status(),
  ).toBe(400);
  // The real Workers route must fail closed for an unresolvable saved host.
  expect(
    (
      await page.request.post('/api/trip/post-image-source', {
        headers,
        data: sourceInput,
      })
    ).status(),
  ).toBe(422);
  const graphic = Buffer.from(
    encode({
      width: 160,
      height: 80,
      channels: 3,
      data: new Uint8Array(160 * 80 * 3).fill(80),
    }),
  );
  await page.route('https://legacy.example.invalid/*.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: graphic }),
  );
  // Source acquisition is isolated; preparation, upload, stored-reference save
  // and the actual publication policy run against the ephemeral application.
  let imports = 0;
  let rejectSource = true;
  let uploads = 0;
  let sourceRequests = 0;
  let releaseSource: (() => void) | undefined;
  const sourceReleased = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  page.on('request', (request) => {
    if (request.url().endsWith('/api/trip/post-image-source')) sourceRequests++;
    if (request.url().endsWith('/api/trip/upload')) {
      uploads++;
      expect(request.postDataBuffer()?.includes(graphic)).toBe(true);
    }
  });
  await page.route('**/api/trip/post-image-source', async (route) => {
    imports++;
    if (!rejectSource) await sourceReleased;
    return rejectSource
      ? route.fulfill({
          status: 422,
          json: { error: 'Synthetic source failure' },
        })
      : route.fulfill({ contentType: 'image/png', body: graphic });
  });
  await page.goto(`/owner/posts/${id}`);
  const editor = page.getByRole('textbox', { name: 'Post content' });
  await expect(editor.locator('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Could not import the saved image. Try again.',
  );
  expect(uploads).toBe(0);
  await expect(editor.locator('img').first()).toHaveAttribute(
    'src',
    'https://legacy.example.invalid/synthetic.png',
  );
  await editor.locator('p').first().click();
  await page.keyboard.insertText(' owner edit');
  await expect(editor).toContainText(' owner edit');
  rejectSource = false;
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/trip/upload') && response.status() === 201,
  );
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect.poll(() => imports).toBe(2);
  await page
    .getByLabel('title', { exact: true })
    .fill('Edited during source import');
  if (!releaseSource) throw new Error('Source release required');
  releaseSource();
  await expect(page.getByRole('status')).toHaveText(
    'draft saved\nnewer edits unsaved',
  );
  const firstSave: unknown = await (
    await page.request.get(`/api/trip/posts?id=${id}`)
  ).json();
  expect(
    z.object({ data: z.object({ title: z.string() }) }).parse(firstSave).data
      .title,
  ).toBe('Synthetic legacy image');
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  const nextSave: unknown = await (
    await page.request.get(`/api/trip/posts?id=${id}`)
  ).json();
  expect(
    z.object({ data: z.object({ title: z.string() }) }).parse(nextSave).data
      .title,
  ).toBe('Edited during source import');
  // Internal imports must never consume Undo or reappear through Redo.
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  for (let index = 0; index < 2; index++)
    await expect(editor.locator('img').nth(index)).toHaveAttribute(
      'src',
      /^\/_emdash\/api\/media\/asset\//,
    );
  await expect(editor).not.toContainText(' owner edit');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor).toContainText(' owner edit');
  for (let index = 0; index < 2; index++)
    await expect(editor.locator('img').nth(index)).toHaveAttribute(
      'src',
      /^\/_emdash\/api\/media\/asset\//,
    );
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  const displayUrl = z
    .object({ sourceUrl: z.string() })
    .parse(await (await uploaded).json()).sourceUrl;
  const imageUrl = await editor.locator('img').first().getAttribute('src');
  if (!imageUrl) throw new Error('Imported image required');
  const anonymous = await browser.newContext();
  try {
    expect(
      (
        await anonymous.request.get(`http://127.0.0.1:4391${displayUrl}`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await anonymous.request.post(
          'http://127.0.0.1:4391/api/trip/post-image-source',
          { data: {} },
        )
      ).status(),
    ).toBe(401);
    await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('published');
    expect(
      (
        await anonymous.request.get(`http://127.0.0.1:4391${displayUrl}`)
      ).status(),
    ).toBe(200);
  } finally {
    await anonymous.close();
  }

  if (process.env.LEGACY_IMAGE_SCREENSHOT)
    await page.screenshot({ path: process.env.LEGACY_IMAGE_SCREENSHOT });
  await expect(page.getByRole('status')).toHaveText('published');
  await expect(editor.locator('img').first()).toHaveAttribute(
    'src',
    /^\/_emdash\/api\/media\/asset\//,
  );
  await page.reload();
  await expect(editor.locator('img').first()).toHaveAttribute(
    'src',
    /^\/_emdash\/api\/media\/asset\//,
  );
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  expect(imports).toBe(3);
  expect(uploads).toBe(2);

  // Older deletion history can restore a duplicate with its original URL even
  // when reconciliation itself stays out of history.
  const duplicateResult = await page.request.post(
    '/_emdash/api/content/posts',
    {
      headers,
      data: {
        slug: 'synthetic-duplicate-history',
        data: {
          title: 'Synthetic duplicate history',
          day: '2026-10-15',
          gallery: [],
          content: ['first', 'second'].map((key) => ({
            _type: 'image',
            _key: key,
            asset: { _ref: sourceInput.source },
            alt: 'Synthetic duplicate image',
          })),
        },
      },
    },
  );
  expect(duplicateResult.status()).toBe(201);
  const duplicateId = created.parse(await duplicateResult.json()).data.item.id;
  await page.goto(`/owner/posts/${duplicateId}`);
  await expect(editor.locator('img')).toHaveCount(2);
  await editor.locator('img').last().click();
  await page.keyboard.press('Backspace');
  await expect(editor.locator('img')).toHaveCount(1);
  const beforeSources = sourceRequests;
  const beforeUploads = uploads;
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  expect(sourceRequests).toBe(beforeSources + 1);
  expect(uploads).toBe(beforeUploads + 1);
  // The real endpoint correctly rejects the old URL after the first save.
  // Restored history must reuse the already imported asset, never refetch it.
  await page.unroute('**/api/trip/post-image-source');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('draft saved');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('img')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('published');
  for (let index = 0; index < 2; index++)
    await expect(editor.locator('img').nth(index)).toHaveAttribute(
      'src',
      /^\/_emdash\/api\/media\/asset\//,
    );
  expect(sourceRequests).toBe(beforeSources + 1);
  expect(uploads).toBe(beforeUploads + 1);
});

for (const scenario of ['distinct images', 'sole image']) {
  test(`saved legacy history recovers a never-imported ${scenario} after deletion and save`, async ({
    page,
  }) => {
    await page.request.post('/_emdash/api/setup/dev-bypass', {
      headers: { 'X-EmDash-Request': '1' },
      data: {},
    });
    await page.route('https://toolbar.bent.build/embed.js', (route) =>
      route.fulfill({ body: '' }),
    );
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/posts/new');
    const headers = {
      'X-EmDash-Request': '1',
      Origin: 'http://127.0.0.1:4391',
    };
    const sourceA = 'https://legacy.example.invalid/history-a.png';
    const sourceB = 'https://legacy.example.invalid/history-b.png';
    const images =
      scenario === 'distinct images' ? [sourceA, sourceB] : [sourceB];
    const data = {
      title: `Synthetic ${scenario}`,
      day: '2026-10-15',
      gallery: [],
      content: [
        {
          _type: 'block',
          _key: 'text',
          style: 'normal',
          children: [
            {
              _type: 'span',
              _key: 'span',
              text: 'Synthetic history',
              marks: [],
            },
          ],
          markDefs: [],
        },
        ...images.map((source, index) => ({
          _type: 'image',
          _key: `image-${String(index)}`,
          asset: { _ref: source },
          alt: `Synthetic image ${String(index)}`,
        })),
      ],
    };
    const result = await page.request.post('/_emdash/api/content/posts', {
      headers,
      data: { slug: `synthetic-history-${String(images.length)}`, data },
    });
    expect(result.status()).toBe(201);
    const id = created.parse(await result.json()).data.item.id;
    // Exercise both an existing native revision and a newly created saved draft
    // whose initial content has not yet received a native revision ID.
    if (scenario === 'distinct images') {
      const current = z
        .object({ data: z.object({ _rev: z.string() }) })
        .parse(
          await (
            await page.request.get(`/_emdash/api/content/posts/${id}`)
          ).json(),
        );
      expect(
        (
          await page.request.put(`/_emdash/api/content/posts/${id}`, {
            headers,
            data: { _rev: current.data._rev, data },
          })
        ).ok(),
      ).toBe(true);
    }
    const saved = z
      .object({ revision: z.string() })
      .parse(await (await page.request.get(`/api/trip/posts?id=${id}`)).json());
    const graphic = Buffer.from(
      encode({
        width: 160,
        height: 80,
        channels: 3,
        data: new Uint8Array(160 * 80 * 3).fill(100),
      }),
    );
    await page.route('https://legacy.example.invalid/*.png', (route) =>
      route.fulfill({ contentType: 'image/png', body: graphic }),
    );
    let acquiredA = 0;
    let acquiredB = 0;
    let uploaded = 0;
    let rejectRestored = true;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/trip/upload')) uploaded++;
    });
    await page.route('**/api/trip/post-image-source', async (route) => {
      // Always execute real current-revision + historical-reference authorization.
      // Only substitute image bytes after the real source acquisition fails on
      // the reserved, nonexistent synthetic host.
      const response = await route.fetch();
      if (response.status() !== 422) return route.fulfill({ response });
      const input = z
        .object({ source: z.string() })
        .parse(route.request().postDataJSON());
      if (input.source === sourceB && rejectRestored) {
        rejectRestored = false;
        return route.fulfill({
          status: 422,
          json: { error: 'Synthetic unavailable source' },
        });
      }
      if (input.source === sourceA) acquiredA++;
      if (input.source === sourceB) acquiredB++;
      return route.fulfill({ contentType: 'image/png', body: graphic });
    });
    await page.goto(`/owner/posts/${id}`);
    const editor = page.getByRole('textbox', { name: 'Post content' });
    await expect(editor.locator('img')).toHaveCount(images.length);
    await editor.locator('img').last().click();
    await page.keyboard.press('Backspace');
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/trip/posts') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('draft saved');
    const savedState = z
      .object({
        post: z.object({
          revision: z.string(),
          imageSourceRevisions: z.record(z.string(), z.string()),
          imageSourceProofs: z.record(z.string(), z.string()),
        }),
      })
      .parse(await (await savedResponse).json()).post;
    const sourceRevision = savedState.imageSourceRevisions[sourceB];
    const sourceProof = savedState.imageSourceProofs[sourceB];
    if (!sourceProof)
      throw new Error('Verified saved reference proof required');
    if (scenario === 'distinct images') {
      if (!sourceRevision) throw new Error('Verified saved snapshot required');
      const request = {
        id,
        revision: savedState.revision,
        source: sourceB,
        sourceRevision,
      };
      const endpoint = '/api/trip/post-image-source';
      // This URL is absent from the new saved document. It remains in a real
      // immutable snapshot, which must belong to this exact post and collection.
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: { ...request, sourceRevision: undefined },
          })
        ).status(),
      ).toBe(400);
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: { ...request, revision: saved.revision },
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: { ...request, sourceRevision: '01K00000000000000000000000' },
          })
        ).status(),
      ).toBe(400);
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: {
              ...request,
              source: 'https://legacy.example.invalid/invented.png',
            },
          })
        ).status(),
      ).toBe(400);
      expect(
        (await page.request.post(endpoint, { data: request })).status(),
      ).toBe(403);
      const anonymous = await page.context().browser()?.newContext();
      if (!anonymous) throw new Error('Browser required');
      try {
        expect(
          (
            await anonymous.request.post('http://127.0.0.1:4391' + endpoint, {
              headers,
              data: request,
            })
          ).status(),
        ).toBe(401);
      } finally {
        await anonymous.close();
      }
      const native = z.object({
        data: z.object({
          _rev: z.string(),
          item: z.object({
            id: z.string(),
            draftRevisionId: z.string().nullish(),
          }),
        }),
      });
      const other = native.parse(
        await (
          await page.request.post('/_emdash/api/content/posts', {
            headers,
            data: { slug: 'synthetic-other-history', data },
          })
        ).json(),
      ).data;
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: {
              id: other.item.id,
              revision: other._rev,
              source: sourceB,
              sourceProof,
            },
          })
        ).status(),
      ).toBe(400);
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: { ...request, id: other.item.id, revision: other._rev },
          })
        ).status(),
      ).toBe(400);
      const beer = native.parse(
        await (
          await page.request.post('/_emdash/api/content/beers', {
            headers,
            data: {
              slug: 'synthetic-history-beer',
              data: { title: 'Synthetic history', day: '2026-10-15', count: 0 },
            },
          })
        ).json(),
      ).data;
      const changedBeer = native.parse(
        await (
          await page.request.put(`/_emdash/api/content/beers/${beer.item.id}`, {
            headers,
            data: {
              _rev: beer._rev,
              data: { title: 'Synthetic history', day: '2026-10-15', count: 1 },
            },
          })
        ).json(),
      ).data;
      if (!changedBeer.item.draftRevisionId)
        throw new Error('Native beer revision required');
      expect(
        (
          await page.request.post(endpoint, {
            headers,
            data: {
              ...request,
              sourceRevision: changedBeer.item.draftRevisionId,
            },
          })
        ).status(),
      ).toBe(400);
    }
    // Saves do not add an editor history event, but native revision retention
    // still prunes the only saved snapshot that contains the deleted image.
    for (let save = 0; save < 52; save++) {
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/trip/posts') &&
          response.request().method() === 'POST',
      );
      await page
        .getByRole('button', { name: 'SAVE DRAFT', exact: true })
        .click();
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('draft saved');
    }
    const retained = z
      .object({
        data: z.object({
          items: z.array(
            z.object({
              id: z.string(),
              data: z.object({ content: z.unknown() }),
            }),
          ),
        }),
      })
      .parse(
        await (
          await page.request.get(
            `/_emdash/api/content/posts/${id}/revisions?limit=100`,
          )
        ).json(),
      ).data.items;
    expect(retained).toHaveLength(50);
    if (sourceRevision)
      expect(retained.map((item) => item.id)).not.toContain(sourceRevision);
    expect(JSON.stringify(retained)).not.toContain(sourceB);
    const current = z
      .object({ revision: z.string() })
      .parse(await (await page.request.get(`/api/trip/posts?id=${id}`)).json());
    const proofInput = {
      id,
      revision: current.revision,
      source: sourceB,
      sourceProof,
    };
    const endpoint = '/api/trip/post-image-source';
    for (const input of [
      { ...proofInput, sourceProof: sourceProof.replace(/^v1/, 'v2') },
      {
        ...proofInput,
        source: 'https://legacy.example.invalid/never-saved.png',
      },
      { ...proofInput, revision: saved.revision },
      { ...proofInput, sourceRevision: '01K00000000000000000000000' },
    ]) {
      expect(
        (await page.request.post(endpoint, { headers, data: input })).status(),
      ).toBeGreaterThanOrEqual(400);
    }
    // Native pruning removed every saved snapshot containing this reference.
    // The proof still authorizes it; the reserved host has no available bytes.
    expect(
      (await page.request.post(endpoint, { data: proofInput })).status(),
    ).toBe(403);
    // Refresh the actual native authentication session without navigating or
    // replacing the still-mounted editor and its owner Undo history.
    expect(
      (
        await page.request.post('/_emdash/api/auth/logout', { headers })
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.post(endpoint, { headers, data: proofInput })
      ).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post('/_emdash/api/auth/dev-bypass', { headers })
      ).status(),
    ).toBe(200);
    const authorized = await page.request.post(endpoint, {
      headers,
      data: proofInput,
    });
    expect(authorized.status()).toBe(422);
    expect(authorized.headers()['cache-control']).toContain('no-store');
    expect(acquiredB).toBe(0); // Deleting an unavailable source must not acquire it.
    expect(uploaded).toBe(images.length - 1);
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('img')).toHaveCount(images.length);
    await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Could not import the saved image. Try again.',
    );
    // A genuine partial failure remains retryable without importing A again.
    rejectRestored = false;
    await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
    try {
      await expect(page.getByRole('status')).toHaveText('draft saved');
    } finally {
      if (process.env.HISTORY_IMAGE_SCREENSHOT)
        await page.screenshot({
          path: `${process.env.HISTORY_IMAGE_SCREENSHOT}-${String(images.length)}.png`,
        });
    }
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(editor.locator('img')).toHaveCount(images.length - 1);
    await page.getByRole('button', { name: 'SAVE DRAFT', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('draft saved');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('img')).toHaveCount(images.length);
    await page.getByRole('button', { name: 'PUBLISH', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('published');
    if (process.env.HISTORY_IMAGE_SCREENSHOT)
      await page.screenshot({
        path: `${process.env.HISTORY_IMAGE_SCREENSHOT}-published-${String(images.length)}.png`,
      });
    for (const image of await editor.locator('img').all())
      await expect(image).toHaveAttribute(
        'src',
        /^\/_emdash\/api\/media\/asset\//,
      );
    expect(acquiredA).toBe(images.length - 1);
    expect(acquiredB).toBe(1);
    expect(uploaded).toBe(images.length);
    await page.reload();
    await expect(editor.locator('img')).toHaveCount(images.length);
    const latest = z
      .object({ revision: z.string() })
      .parse(await (await page.request.get(`/api/trip/posts?id=${id}`)).json());
    expect(
      (
        await page.request.delete(`/_emdash/api/content/posts/${id}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.post(endpoint, {
          headers,
          data: { ...proofInput, revision: latest.revision },
        })
      ).status(),
    ).toBe(404);
  });
}
