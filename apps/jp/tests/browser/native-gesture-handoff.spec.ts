import { expect, test } from '@playwright/test';
import {
  positionMediaForSwipe,
  stableMediaPosition,
  swipe,
} from '../fixtures/native-gesture';

test('native vertical input settles before positioning the next swipe', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <style>body { margin: 0; height: 4000px; }
    #media { position: absolute; top: 989px; width: 390px; height: 400px;
      background: blue; touch-action: pan-y; }</style>
    <div id="media">Synthetic input target</div>
  `);
  const frame = page.locator('#media');

  // Replay the retained natural 909 -> 927 positioning sequence. This only
  // validates the precondition; it makes no claim about Embla's counter.
  await frame.evaluate(() => {
    window.scrollTo(0, 909);
    requestAnimationFrame(() => {
      window.scrollTo(0, 927);
    });
  });
  const replay = await stableMediaPosition(frame);
  expect(replay.scrollY).toBe(927);
  expect(replay.y).toBe(62);

  await positionMediaForSwipe(frame);
  const beforeVertical = await page.evaluate(() => scrollY);
  await swipe(page, { x: 195, y: 400 }, { x: 195, y: 110 });
  expect((await page.evaluate(() => scrollY)) - beforeVertical).toBeGreaterThan(
    80,
  );

  // Controlled residual native-handoff motion, not a natural counter failure.
  // Continue changing position on consecutive RAFs so an immediate reset and
  // boundingBox can proceed while unsettled. No horizontal input is sent yet.
  await frame.evaluate((element) => {
    element.setAttribute('data-residual-motion', 'active');
    let remaining = 12;
    const move = () => {
      window.scrollBy(0, 18);
      if (--remaining) requestAnimationFrame(move);
      else element.setAttribute('data-residual-motion', 'complete');
    };
    requestAnimationFrame(move);
  });
  const positioned = await positionMediaForSwipe(frame);
  // This is the dispatch seam: the old precondition returns while motion is
  // active. The corrected precondition must settle before it supplies coords.
  expect(await frame.getAttribute('data-residual-motion')).toBe('complete');
  expect(positioned.y).toBe(80);
  expect(await stableMediaPosition(frame)).toEqual(positioned);

  await swipe(
    page,
    { x: positioned.x + positioned.width - 35, y: positioned.y + 100 },
    { x: positioned.x + 35, y: positioned.y + 100 },
  );
  expect(await page.evaluate(() => scrollY)).toBe(positioned.scrollY);
});
