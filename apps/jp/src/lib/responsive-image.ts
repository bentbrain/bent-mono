// Only native display previews participate. Demo, external, and owner URLs keep
// their existing delivery path; callers never turn arbitrary URLs into sources.
const imageWidths = [320, 480, 800, 1120, 1600];
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const assetId = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const fileSource = new RegExp(
  `^/_emdash/api/media/file/trip/(${uuid})/(photo|poster)\\.jpg$`,
);
const assetSource = new RegExp(
  `^/_emdash/api/media/asset/(${assetId})/[^/?#]+$`,
);
export const displayPreviewKey = new RegExp(
  `^trip/${uuid}/(photo|poster)\\.jpg$`,
);
export const previewPath = new RegExp(
  `^/media-preview/(asset/(${assetId})|file/(${uuid})/(photo|poster)\\.jpg)/(320|480|800|1120|1600)/(auto|jpeg|webp)$`,
);

export function displayPreviewReference(source: string) {
  const file = fileSource.exec(source);
  const asset = assetSource.exec(source);
  const folder = file?.[1];
  const filename = file?.[2];
  const id = asset?.[1];
  const reference =
    folder && filename
      ? `file/${folder}/${filename}.jpg`
      : id
        ? `asset/${id}`
        : undefined;
  return reference;
}

export function responsiveImage(
  source: string,
  sizes: string,
  sourceWidth?: number,
) {
  const reference = displayPreviewReference(source);
  if (!reference) return { src: source };
  return {
    src: source,
    srcSet: imageWidths
      // Keep one terminal candidate at the actual source width. Larger width
      // descriptors would shrink auto-width images through density correction.
      .filter(
        (_width, index) =>
          !sourceWidth ||
          index === 0 ||
          (imageWidths[index - 1] || 0) < sourceWidth,
      )
      .map(
        (width) =>
          `/media-preview/${reference}/${String(width)}/auto ${String(sourceWidth ? Math.min(width, sourceWidth) : width)}w`,
      )
      .join(', '),
    sizes,
  };
}

// These expressions follow Site's 1400px content limit and its 16/24px padding.
export const cardImageSizes =
  '(min-width: 1400px) 440px, (min-width: 901px) calc((100vw - 84px) / 3), (min-width: 601px) calc((100vw - 66px) / 2), calc(100vw - 34px)';
export const galleryImageSizes =
  '(min-width: 1400px) 446px, (min-width: 901px) calc((100vw - 62px) / 3), (min-width: 601px) calc((100vw - 55px) / 2), calc(100vw - 32px)';
export const postImageSizes =
  '(min-width: 848px) 800px, (min-width: 601px) calc(100vw - 48px), calc(100vw - 32px)';

export const postMosaicImageSizes =
  '(min-width: 848px) 396.5px, (min-width: 601px) calc((100vw - 55px) / 2), calc(100vw - 32px)';

// Inline photos sit inside the homepage card's 2px border and 32px content
// padding. Gallery gaps are 12px; below 601px every gallery has one column.
export function inlineImageSizes(singlePost: boolean, columns: number) {
  const gaps = 12 * (columns - 1);
  if (singlePost)
    return `(min-width: 848px) calc(${String(800 - gaps)}px / ${String(columns)}), (min-width: 601px) calc((100vw - ${String(48 + gaps)}px) / ${String(columns)}), calc(100vw - 32px)`;
  return `(min-width: 1400px) calc(${String(406 - gaps)}px / ${String(columns)}), (min-width: 901px) calc((100vw - ${String(182 + 3 * gaps)}px) / ${String(3 * columns)}), (min-width: 601px) calc((100vw - ${String(132 + 2 * gaps)}px) / ${String(2 * columns)}), calc(100vw - 66px)`;
}

// Match the map's horizontal slot and 55dvh height cap before image creation.
export function mapPhoto(
  source: string,
  dimensions?: { width: number; height: number } | null,
) {
  if (!dimensions)
    return responsiveImage(
      source,
      '(min-width: 672px) 614px, calc(100vw - 58px)',
    );
  const heightWidth = `${String((55 * dimensions.width) / dimensions.height)}dvh`;
  return responsiveImage(
    source,
    `(min-width: 672px) min(614px, ${heightWidth}), min(calc(100vw - 58px), ${heightWidth})`,
    Math.min(
      dimensions.width,
      Math.max(1, Math.round((1600 * dimensions.width) / dimensions.height)),
    ),
  );
}
