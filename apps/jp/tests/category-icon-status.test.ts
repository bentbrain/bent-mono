import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { act, createElement } from 'react';
import { installDom } from './helpers/dom';
import {
  categoryIconStatusSchema,
  type CategoryIconStatus as Status,
} from '../src/lib/category-icons';

const dom = installDom();
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } =
  await import('@tanstack/react-query');
const { CategoryIconStatus } =
  await import('../src/components/CategoryIconStatus');
after(() => {
  dom.cleanup();
});

async function update(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function settled(predicate: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await act(async () => {
      await setTimeout(5);
    });
  }
  assert.ok(predicate(), 'mounted component did not settle');
}

async function mount(t: TestContext, initial: Status[], names = ['ramen']) {
  let icons = initial;
  const posted: unknown[] = [];
  let postError = '';
  let releasePost: (() => void) | undefined;
  let heldPost: Promise<void> | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, '/api/trip/category-icons');
      assert.equal(new Headers(init?.headers).get('X-EmDash-Request'), '1');
      if (init?.method === 'POST') {
        assert.equal(
          new Headers(init.headers).get('Content-Type'),
          'application/json',
        );
        assert.equal(typeof init.body, 'string');
        if (typeof init.body !== 'string')
          throw new Error('expected JSON body');
        const body: unknown = JSON.parse(init.body);
        posted.push(body);
        await heldPost;
        if (postError)
          return Response.json({ error: postError }, { status: 409 });
        icons = initial.map((icon) => ({
          ...icon,
          state: 'pending',
          canRetry: false,
        }));
        return Response.json({ queued: true });
      }
      return Response.json({ icons });
    },
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    releasePost?.();
    await act(async () => {
      root.unmount();
      await client.cancelQueries();
    });
    client.clear();
    container.remove();
  });
  await update(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CategoryIconStatus, { names }),
      ),
    );
  });
  await settled(() => container.textContent.includes('icon ·'));
  return {
    container,
    posted,
    holdPost() {
      heldPost = new Promise<void>((resolve) => {
        releasePost = resolve;
      });
    },
    releasePost() {
      releasePost?.();
    },
    failPost(message: string) {
      postError = message;
    },
  };
}

function icon(state: Status['state'], canRetry: boolean): Status {
  return { label: 'ramen', normalized: 'ramen', state, canRetry };
}

// canonicalcaseID: b09a55bb7e7e50e14a40-652f21f5a038a4c1221c
const labels: Record<Status['state'], string> = {
  default: 'fallback',
  pending: 'pending',
  ready: 'ready',
  failed: 'failed',
  uncertain: 'result unknown; retry may charge again',
  setup:
    'add OPENAI_API_KEY in deployment secrets and configure an image model',
  configuration:
    'check the image service key, model and account access, then retry',
};

for (const state of categoryIconStatusSchema.shape.state.options) {
  for (const canRetry of [false, true]) {
    void test(`mounted icon status ${state} honors canRetry=${String(canRetry)}`, async (t) => {
      const fixture = await mount(t, [icon(state, canRetry)]);
      assert.ok(
        fixture.container.textContent.includes(`ramen icon · ${labels[state]}`),
      );
      const buttons = fixture.container.querySelectorAll('button');
      assert.equal(buttons.length, canRetry ? 1 : 0);
      if (canRetry) {
        assert.equal(
          buttons[0]?.textContent,
          state === 'ready'
            ? 'REGENERATE'
            : state === 'uncertain'
              ? 'RETRY (MAY CHARGE)'
              : 'RETRY',
        );
        assert.equal(buttons[0].disabled, false);
      }
      assert.deepEqual(fixture.posted, []);
    });
  }
}

void test('mounted icon status distinguishes built-in defaults, filters names and renders icon masks', async (t) => {
  const fixture = await mount(
    t,
    [
      { label: 'food', normalized: 'food', state: 'default', canRetry: false },
      { ...icon('ready', false), url: '/category-icons/synthetic.png' },
      {
        label: 'unselected',
        normalized: 'unselected',
        state: 'failed',
        canRetry: true,
      },
    ],
    [' FOOD ', 'ramen'],
  );
  assert.ok(fixture.container.textContent.includes('food icon · built-in'));
  assert.ok(fixture.container.textContent.includes('ramen icon · ready'));
  assert.equal(fixture.container.textContent.includes('unselected'), false);
  assert.equal(fixture.container.querySelectorAll('button').length, 0);
  assert.ok(
    fixture.container
      .querySelector('[aria-hidden="true"]')
      ?.getAttribute('style')
      ?.includes('/category-icons/synthetic.png'),
  );
});

for (const state of categoryIconStatusSchema.shape.state.options) {
  void test(`mounted icon ${state} action sends explicit charge acknowledgement then refreshes pending`, async (t) => {
    const fixture = await mount(t, [icon(state, true)]);
    const button = fixture.container.querySelector('button');
    assert.ok(button);
    fixture.holdPost();
    await update(() => {
      button.click();
    });
    await settled(() => fixture.posted.length === 1);
    assert.deepEqual(fixture.posted, [
      { category: 'ramen', acknowledgeCharge: state === 'uncertain' },
    ]);
    assert.equal(button.textContent, 'QUEUING');
    assert.equal(button.disabled, true);
    await update(() => {
      button.click();
    });
    assert.equal(fixture.posted.length, 1);
    await update(() => {
      fixture.releasePost();
    });
    await settled(() =>
      fixture.container.textContent.includes('ramen icon · pending'),
    );
    assert.equal(fixture.container.querySelectorAll('button').length, 0);
  });
}

void test('mounted icon retry reports a rejected request and restores the action', async (t) => {
  const fixture = await mount(t, [icon('uncertain', true)]);
  fixture.failPost('retry cap reached');
  const button = fixture.container.querySelector('button');
  assert.ok(button);
  await update(() => {
    button.click();
  });
  await settled(
    () =>
      fixture.container.querySelector('[role="status"]')?.textContent ===
      'retry cap reached',
  );
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'RETRY (MAY CHARGE)');
  assert.deepEqual(fixture.posted, [
    { category: 'ramen', acknowledgeCharge: true },
  ]);
});
