import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { act, createElement } from 'react';
import { installDom } from './helpers/dom';
import { tripMap } from '../src/lib/map';
import { contextTiles } from '../src/lib/map-context';

const dom = installDom();
const { createRoot } = await import('react-dom/client');
const { MapContext } = await import('../src/components/MapContext');
after(() => {
  dom.cleanup();
});
const station = { latitude: 35.681236, longitude: 139.767125 };
const map = tripMap([station]);
const point = map.projectMedia(station);
assert.ok(point);
const size = { width: 1280, height: 440 };
const onUnavailable = () => {};

async function update(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

void test('empty ocean tiles share one viewport background with loaded geometry', async (t) => {
  const bytes = await readFile(
    new URL('./fixtures/map-context/4-14-6.pbf', import.meta.url),
  );
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return Promise.resolve(
      url.endsWith('/4/14/6.pbf')
        ? new Response(bytes)
        : new Response(null, { status: 404 }),
    );
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    for (const width of [1280, 390]) {
      await update(() => {
        root.render(
          createElement(
            'svg',
            null,
            createElement(MapContext, {
              camera: { x: point[0], y: point[1], zoom: 0.75 },
              size: { ...size, width },
              projection: map.projection,
              onUnavailable,
              revision: 0,
            }),
          ),
        );
      });
      await act(async () => {
        await setTimeout(200);
      });
      assert.doesNotMatch(
        container.textContent || '',
        /[\u3040-\u30ff\u3400-\u9fff]/,
        'the geometry overlay must not display Japanese or non-place annotations',
      );
      const background = container.querySelector(
        '[data-map-detail-background]',
      );
      assert.ok(background);
      assert.equal(background.getAttribute('width'), String(width));
      assert.equal(background.getAttribute('height'), String(size.height));
      assert.equal(
        container.querySelectorAll('[data-map-vector-tile] > rect').length,
        0,
      );
      assert.ok(
        container
          .querySelector('[data-map-layer="AdmArea"]')
          ?.classList.contains('dark:fill-muted'),
      );
    }
  } finally {
    await update(() => {
      root.unmount();
    });
  }
});

void test('panning with cancelled delayed requests evicts old completed tiles', async (t) => {
  const bytes = await readFile(
    new URL('./fixtures/map-context/16-58211-25806.pbf', import.meta.url),
  );
  let held = '';
  let aborted = 0;
  const fulfilled: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === held) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(new Error('Delayed tile cancelled'));
            },
            { once: true },
          );
        });
      }
      fulfilled.push(url);
      return new Response(bytes);
    },
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  const firstViewport = new Set<string>();
  try {
    for (let index = 0; index < 35; index++) {
      const camera = {
        x: point[0] + (index * 1600) / 3072,
        y: point[1],
        zoom: 3072,
      };
      const delayed = contextTiles(camera, size, map.projection).at(-1);
      assert.ok(delayed);
      held = `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${delayed.key}.pbf`;
      await update(() => {
        root.render(
          createElement(
            'svg',
            null,
            createElement(MapContext, {
              camera,
              size,
              projection: map.projection,
              onUnavailable,
              revision: 0,
            }),
          ),
        );
      });
      await act(async () => {
        await setTimeout(180);
      });
      if (index === 0) fulfilled.forEach((url) => firstViewport.add(url));
    }
    assert.ok(aborted >= 34);
    assert.ok(firstViewport.size > 0);
    const before = fulfilled.length;
    held = '';
    await update(() => {
      root.render(
        createElement(
          'svg',
          null,
          createElement(MapContext, {
            camera: { x: point[0], y: point[1], zoom: 3072 },
            size,
            projection: map.projection,
            onUnavailable,
            revision: 0,
          }),
        ),
      );
    });
    await act(async () => {
      await setTimeout(200);
    });
    assert.ok(
      fulfilled.slice(before).some((url) => firstViewport.has(url)),
      'old completed tiles must be evicted even when every earlier batch was cancelled',
    );
  } finally {
    await update(() => {
      root.unmount();
    });
  }
});

void test('English place nodes keep their geographic positions and identity across panning and tile arrivals', async (t) => {
  const { MapPlaceLabels } = await import('../src/components/MapPlaceLabels');
  const bytes = await readFile(
    new URL('./fixtures/map-places/16-58211-25806.geojson', import.meta.url),
    'utf8',
  );
  const requests: {
    url: string;
    credentials?: RequestCredentials;
    referrerPolicy?: ReferrerPolicy;
  }[] = [];
  let fail = false;
  const errors: boolean[] = [];
  const status = (value: boolean) => {
    errors.push(value);
  };
  t.mock.method(
    globalThis,
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({
        url,
        credentials: init?.credentials,
        referrerPolicy: init?.referrerPolicy,
      });
      if (fail)
        return Promise.reject(new Error('Synthetic unavailable annotations'));
      return Promise.resolve(new Response(bytes));
    },
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  const stationY = point[1];
  async function render(x: number, revision = 0) {
    await update(() => {
      root.render(
        createElement(
          'svg',
          null,
          createElement(MapPlaceLabels, {
            camera: { x, y: stationY, zoom: 1536 },
            size,
            projection: map.projection,
            pins: [],
            revision,
            onUnavailable: status,
          }),
        ),
      );
    });
    await act(async () => {
      await setTimeout(200);
    });
  }
  try {
    await render(point[0]);
    const name = container.querySelector('[data-map-place]');
    assert.ok(name);
    assert.equal(name.textContent, 'marunouchi 2');
    const x = Number(name.getAttribute('x'));
    const y = Number(name.getAttribute('y'));
    await render(point[0] - 60 / 1536);
    assert.equal(container.querySelector('[data-map-place]'), name);
    assert.ok(Math.abs(Number(name.getAttribute('x')) - x - 60) < 1e-6);
    assert.equal(Number(name.getAttribute('y')), y);
    await render(point[0]);
    assert.equal(container.querySelector('[data-map-place]'), name);
    assert.equal(Number(name.getAttribute('x')), x);
    assert.ok(requests.length > 0 && requests.length <= 32);
    assert.ok(
      requests.every(
        (request) =>
          /^https:\/\/maps\.gsi\.go\.jp\/xyz\/experimental_multil\/\d+\/\d+\/\d+\.geojson$/.test(
            request.url,
          ) &&
          request.credentials === 'omit' &&
          request.referrerPolicy === 'no-referrer',
      ),
    );
    fail = true;
    await render(point[0] + 5000 / 1536);
    assert.equal(errors.at(-1), true);
    fail = false;
    await render(point[0] + 5000 / 1536, 1);
    assert.equal(errors.at(-1), false);
  } finally {
    await update(() => {
      root.unmount();
    });
  }
});
