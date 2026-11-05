import { test, expect } from '@playwright/test';

for (const width of [390, 1280]) {
  for (const deviceScaleFactor of [1, 2]) {
    for (const colorScheme of ['light', 'dark']) {
      test(`compact beer has a solid mug and open handle at ${String(width)}px DPR${String(deviceScaleFactor)} ${colorScheme}`, async ({
        browser,
        baseURL,
      }) => {
        const context = await browser.newContext({
          baseURL,
          viewport: { width, height: 844 },
          deviceScaleFactor,
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        });
        try {
          const page = await context.newPage();
          await page.route('https://toolbar.bent.build/**', (route) =>
            route.fulfill({ contentType: 'application/javascript', body: '' }),
          );
          await page.goto('/');
          await page.evaluate(() => document.fonts.ready);
          const icon = page.locator('[data-feedback-id="beer-icon"]');
          const box = await icon.boundingBox();
          if (!box) throw new Error('Visible beer icon required');
          const clip = {
            x: Math.floor(box.x) - 2,
            y: Math.floor(box.y) - 2,
            width: Math.ceil(box.width) + 4,
            height: Math.ceil(box.height) + 4,
          };
          const raster = await page.screenshot({ clip });
          if (process.env.BEER_EVIDENCE) {
            const header = await page.locator('.site-header').boundingBox();
            if (!header) throw new Error('Header required');
            await page.screenshot({
              path: `${process.env.BEER_EVIDENCE}/${String(width)}-dpr${String(deviceScaleFactor)}-${colorScheme}.png`,
              clip: { x: 0, y: 0, width, height: header.height + 24 },
            });
          }
          const metrics = await icon.evaluate(
            async (svg, { image, clip, box, scale }) => {
              const canvas = document.createElement('canvas');
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Raster context required');
              const img = new Image();
              img.src = `data:image/png;base64,${image}`;
              await img.decode();
              canvas.width = img.width;
              canvas.height = img.height;
              context.drawImage(img, 0, 0);
              const pixels = context.getImageData(
                0,
                0,
                img.width,
                img.height,
              ).data;
              const color = getComputedStyle(svg)
                .color.match(/[\d.]+/g)
                ?.map(Number);
              if (!color || color.length < 3)
                throw new Error('Icon color required');
              const painted = (x: number, y: number) => {
                const i = (y * img.width + x) * 4;
                return [0, 1, 2].every(
                  (c) => Math.abs((pixels[i + c] ?? 0) - (color[c] ?? 0)) < 35,
                );
              };
              // Sample the actual screen raster, including fractional placement
              // and crisp-edge snapping, rather than rasterizing an SVG copy.
              const coverage = (
                left: number,
                top: number,
                right: number,
                bottom: number,
              ) => {
                let total = 0;
                let ink = 0;
                for (let y = 0; y < img.height; y++) {
                  for (let x = 0; x < img.width; x++) {
                    const nx = (clip.x + (x + 0.5) / scale - box.x) / box.width;
                    const ny =
                      (clip.y + (y + 0.5) / scale - box.y) / box.height;
                    if (nx >= left && nx < right && ny >= top && ny < bottom) {
                      total++;
                      if (painted(x, y)) ink++;
                    }
                  }
                }
                if (!total) throw new Error('Raster region has no pixels');
                return ink / total;
              };
              let first = img.height;
              let last = -1;
              for (let y = 0; y < img.height; y++) {
                for (let x = 0; x < img.width; x++) {
                  if (painted(x, y)) {
                    first = Math.min(first, y);
                    last = Math.max(last, y);
                  }
                }
              }
              let foamPeaks = 0;
              let previous = false;
              for (let x = 0; x < img.width; x++) {
                const ink = painted(x, first);
                if (ink && !previous) foamPeaks++;
                previous = ink;
              }
              const foreground = color.slice(0, 3).map((value) => {
                const s = value / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
              });
              const luminance =
                (foreground[0] ?? 0) * 0.2126 +
                (foreground[1] ?? 0) * 0.7152 +
                (foreground[2] ?? 0) * 0.0722;
              const background = getComputedStyle(
                document.body,
              ).backgroundColor;
              const dark = matchMedia('(prefers-color-scheme: dark)').matches;
              return {
                foamPeaks,
                body: coverage(0.08, 0.4, 0.55, 0.83),
                handle: coverage(0.68, 0.4, 0.86, 0.59),
                paintedHeight: (last + 1 - first) / scale,
                first: clip.y + first / scale,
                bottom: clip.y + (last + 1) / scale,
                contrast: dark
                  ? (luminance + 0.05) / 0.05
                  : 1.05 / (luminance + 0.05),
                background,
              };
            },
            {
              image: raster.toString('base64'),
              clip,
              box,
              scale: deviceScaleFactor,
            },
          );
          expect
            .soft(metrics.body, JSON.stringify(metrics))
            .toBeGreaterThan(0.85);
          expect
            .soft(metrics.handle, JSON.stringify(metrics))
            .toBeLessThan(0.15);
          expect(metrics.foamPeaks).toBe(2);
          expect(metrics.paintedHeight).toBeGreaterThanOrEqual(7);
          expect(
            Math.abs(metrics.paintedHeight - box.height),
          ).toBeLessThanOrEqual(1 / deviceScaleFactor);
          expect(metrics.first).toBeGreaterThanOrEqual(
            box.y - 1 / deviceScaleFactor,
          );
          expect(metrics.bottom).toBeLessThanOrEqual(
            box.y + box.height + 1 / deviceScaleFactor,
          );
          expect(metrics.background).toBe(
            colorScheme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
          );
          expect(metrics.contrast).toBeGreaterThanOrEqual(3);
        } finally {
          await context.close();
        }
      });
    }
  }
}
