import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

// Independently verified glyf bounds from the bundled static Latin 700 face.
// The served-font digest below prevents stale bounds after a font update.
const geistMono700 = {
  sha256: 'e26f16d6bda234828e574c948d9a5aca1327f83df2b3529a4ebea406ca026d0c',
  unitsPerEm: 1000,
  glyphs: [
    { glyph: '0', yMin: -16, yMax: 726 },
    { glyph: 'I', yMin: 0, yMax: 710 },
  ],
};

for (const width of [390, 1280, 1778]) {
  test(`header matches shop typography and height at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const header = page.locator('.site-header');
    await expect(header).toHaveCSS('font-size', '11.2px');
    await expect(header).toHaveCSS('font-weight', '700');
    await expect(header).toHaveCSS('line-height', '16.8px');
    await expect(header).toHaveCSS('letter-spacing', '0.56px');
    expect(
      await header.evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(48);
    await expect(
      page.getByRole('link', { name: 'blog', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'pics', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(page.locator('body')).toHaveCSS('font-size', '13px');
  });
}

for (const width of [390, 1280]) {
  for (const fontSize of [16, 32]) {
    for (const colorScheme of ['light', 'dark']) {
      test(`header icons match tall glyphs at ${String(width)}px, ${String(fontSize)}px default text, ${colorScheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        });
        const servedFont = page.waitForResponse(
          (response) =>
            response.url().includes('geist-mono-latin-700-normal') &&
            new URL(response.url()).pathname.endsWith('.woff2'),
        );
        await page.goto('/');
        await page.evaluate(async (size) => {
          document.documentElement.style.fontSize = `${String(size)}px`;
          await document.fonts.ready;
        }, fontSize);
        const fontResponse = await servedFont;
        expect(fontResponse.ok()).toBe(true);
        expect(
          createHash('sha256')
            .update(await fontResponse.body())
            .digest('hex'),
          'Remeasure the bundled glyph outlines when the served font changes',
        ).toBe(geistMono700.sha256);
        const metrics = await page
          .locator('.site-header')
          .evaluate(async (header) => {
            const icon = header.querySelector('.beer svg');
            const path = header.querySelector('.beer path');
            const label = header.querySelector('.beer span');
            const brand = header.querySelector('.brand');
            const flag = brand?.querySelector('img');
            if (
              !(icon instanceof SVGSVGElement) ||
              !(path instanceof SVGGraphicsElement) ||
              !(flag instanceof HTMLImageElement) ||
              !label ||
              !brand
            )
              throw new Error('Header icons and labels required');
            const style = getComputedStyle(label);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context)
              throw new Error('Flag rasterization context required');
            const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const faces = await document.fonts.load(font, '0I');
            const fontLoaded = faces.some(
              (face) =>
                face.family === 'Geist Mono' &&
                face.weight === '700' &&
                face.status === 'loaded',
            );
            const baseline = (element: Element) => {
              const probe = document.createElement('span');
              probe.style.cssText = 'display:inline-block;width:0;height:0';
              element.append(probe);
              const value = probe.getBoundingClientRect().bottom;
              probe.remove();
              return value;
            };
            const beerBaseline = baseline(label);
            // A flex item's baseline is also its last line's text baseline.
            const brandText = document.createElement('span');
            brandText.textContent = 'I';
            brand.append(brandText);
            const brandBaseline = baseline(brandText);
            brandText.remove();
            const bounds = path.getBBox();
            const transform = path.getScreenCTM();
            if (!transform) throw new Error('Rendered SVG transform required');
            const beerTop = new DOMPoint(bounds.x, bounds.y).matrixTransform(
              transform,
            ).y;
            const beerBottom = new DOMPoint(
              bounds.x,
              bounds.y + bounds.height,
            ).matrixTransform(transform).y;
            await flag.decode();
            const box = flag.getBoundingClientRect();
            // Rasterize the actual asset, including transparent padding and stroke.
            const scale = 16;
            canvas.width = Math.ceil(box.width * scale);
            canvas.height = Math.ceil(box.height * scale);
            context.drawImage(
              flag,
              0,
              0,
              box.width * scale,
              box.height * scale,
            );
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let first = canvas.height;
            let last = -1;
            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                if ((pixels[(y * canvas.width + x) * 4 + 3] ?? 0) > 127) {
                  first = Math.min(first, y);
                  last = Math.max(last, y);
                }
              }
            }
            if (last < 0) throw new Error('Flag must paint visible pixels');
            return {
              fontLoaded,
              font,
              fontSize: parseFloat(style.fontSize),
              fontWeight: style.fontWeight,
              fontStyle: style.fontStyle,
              beer: {
                height: beerBottom - beerTop,
                bottom: beerBottom,
                baseline: beerBaseline,
              },
              flag: {
                height: (last + 1 - first) / scale,
                bottom: box.top + (last + 1) / scale,
                baseline: brandBaseline,
              },
            };
          });
        expect(metrics.fontLoaded, metrics.font).toBe(true);
        expect(metrics.fontWeight).toBe('700');
        expect(metrics.fontStyle).toBe('normal');
        expect(metrics.fontSize).toBeCloseTo(fontSize * 0.7, 4);
        const glyphs = geistMono700.glyphs.map((glyph) => ({
          glyph: glyph.glyph,
          height:
            ((glyph.yMax - glyph.yMin) / geistMono700.unitsPerEm) *
            metrics.fontSize,
        }));
        for (const [name, icon] of Object.entries({
          beer: metrics.beer,
          flag: metrics.flag,
        })) {
          for (const glyph of glyphs) {
            expect
              .soft(
                Math.abs(icon.height - glyph.height),
                `${name} versus ${glyph.glyph} outline: ${JSON.stringify(metrics)}`,
              )
              .toBeLessThanOrEqual((0.5 * fontSize) / 16);
          }
          expect
            .soft(
              Math.abs(icon.bottom - icon.baseline),
              `${name} baseline: ${JSON.stringify(metrics)}`,
            )
            .toBeLessThanOrEqual(1);
        }
      });
    }
  }
}

for (const owner of [false, true]) {
  test(`${owner ? 'owner' : 'public'} navigation wraps on narrow screens without overflow`, async ({
    page,
    baseURL,
  }) => {
    if (owner) {
      const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
        headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
        data: {},
      });
      expect(setup.ok()).toBe(true);
      await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
      await page.waitForURL((url) => url.pathname === '/owner');
    } else {
      await page.goto('/');
    }
    await page.setViewportSize({ width: 320, height: 844 });
    const navigation = page.getByRole('navigation', {
      name: 'Main navigation',
    });
    await expect(navigation).toBeVisible();
    for (const name of ['blog', 'pics'])
      await expect(
        navigation.getByRole('link', { name, exact: true }),
      ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
    expect(
      await page
        .locator('.site-header')
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThan(48);
  });
}

for (const owner of [false, true]) {
  for (const width of [360, 601, 602, 800]) {
    test(`${owner ? 'owner' : 'public'} header fits enlarged default text at ${String(width)}px`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      if (owner) {
        const setup = await page.request.post('/_emdash/api/setup/dev-bypass', {
          headers: { 'X-EmDash-Request': '1', Origin: baseURL ?? '' },
          data: {},
        });
        expect(setup.ok()).toBe(true);
        await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner');
        await page.waitForURL((url) => url.pathname === '/owner');
      } else {
        await page.goto('/');
      }
      await expect(
        page.getByRole('navigation', { name: 'Main navigation' }),
      ).toBeVisible();
      await page.evaluate(async () => {
        document.documentElement.style.fontSize = '32px';
        await document.fonts.ready;
      });
      await expect(page.locator('.site-header')).toHaveCSS(
        'font-size',
        '22.4px',
      );
      const dimensions = await page
        .locator('.site-header')
        .evaluate((header) => {
          const box = header.getBoundingClientRect();
          return {
            width: document.documentElement.scrollWidth,
            links: [...header.querySelectorAll('a')].map((link) => {
              const rect = link.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(link);
              const content = range.getBoundingClientRect();
              return {
                text: link.textContent.trim(),
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                contentLeft: content.left,
                contentRight: content.right,
              };
            }),
            top: box.top,
            bottom: box.bottom,
          };
        });
      expect(dimensions.width, JSON.stringify(dimensions)).toBe(width);
      for (const link of dimensions.links) {
        expect(link.left, link.text).toBeGreaterThanOrEqual(0);
        expect(link.right, link.text).toBeLessThanOrEqual(width);
        expect(link.top, link.text).toBeGreaterThanOrEqual(dimensions.top);
        expect(link.bottom, link.text).toBeLessThanOrEqual(dimensions.bottom);
        expect(link.contentLeft, link.text).toBeGreaterThanOrEqual(
          link.left - 1,
        );
        expect(link.contentRight, link.text).toBeLessThanOrEqual(
          link.right + 1,
        );
      }
    });
  }
}
