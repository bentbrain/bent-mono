import type { Locator, Page } from '@playwright/test';

// Native touchEnd acknowledges input before the compositor necessarily finishes
// scrolling. Sample the document, visual viewport and intended target together.
export async function stableMediaPosition(frame: Locator) {
  return frame.evaluate(
    (element) =>
      new Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
        scrollY: number;
      }>((resolve, reject) => {
        let previous: number[] = [];
        let consecutive = 0;
        let raf = 0;
        const timeout = setTimeout(() => {
          cancelAnimationFrame(raf);
          reject(new Error('Media position did not settle before touch input'));
        }, 5_000);
        const sample = () => {
          const box = element.getBoundingClientRect();
          const viewport = window.visualViewport;
          const values = [
            scrollX,
            scrollY,
            viewport?.offsetLeft ?? 0,
            viewport?.offsetTop ?? 0,
            viewport?.pageLeft ?? scrollX,
            viewport?.pageTop ?? scrollY,
            viewport?.width ?? innerWidth,
            viewport?.height ?? innerHeight,
            viewport?.scale ?? 1,
            box.x,
            box.y,
            box.width,
            box.height,
          ];
          consecutive =
            element.isConnected &&
            box.width > 0 &&
            box.height > 0 &&
            values.every((value, index) => value === previous[index])
              ? consecutive + 1
              : 0;
          previous = values;
          if (consecutive >= 4) {
            clearTimeout(timeout);
            resolve({
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              scrollY,
            });
          } else raf = requestAnimationFrame(sample);
        };
        sample();
      }),
  );
}

export async function positionMediaForSwipe(frame: Locator) {
  await stableMediaPosition(frame);
  await frame.evaluate((element) => {
    window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 80);
  });
  return stableMediaPosition(frame);
}

export async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const cdp = await page.context().newCDPSession(page);
  let active = false;
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [from],
    });
    active = true;
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * i) / 10,
            y: from.y + ((to.y - from.y) * i) / 10,
          },
        ],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
              resolve();
            }),
          ),
      );
    }
    // Relinquish ownership before dispatch so an acknowledgement failure cannot
    // send a second touchEnd for a gesture that Chrome already released.
    active = false;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    try {
      if (active)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
    } finally {
      await cdp.detach();
    }
  }
}
