import "server-only";

import type { ProductDto } from "@forever-tee/contracts";
import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import sharp from "sharp";

import { productImagePath } from "@/lib/product-image";
import {
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_SETTINGS,
  SOCIAL_CARD_WIDTH,
  resolveSocialCardColor,
  socialCardLayout,
} from "@/lib/social-card";

const COBALT = "#0647ff";
const WHITE = "#ffffff";
const CACHE_CONTROL = "no-store";
export const SOCIAL_CARD_FONT_FAMILY = "Geist Mono";

const geistMonoDirectory = join(process.cwd(), "assets/fonts/geist-mono");
const geistMonoRegular = readFile(
  join(geistMonoDirectory, "GeistMono-Regular.ttf"),
);
const geistMonoBold = readFile(
  join(geistMonoDirectory, "GeistMono-Bold.ttf"),
);
const inverseLogo = readFile(join(process.cwd(), "assets/brand/logo.png"))
  .then((logo) => sharp(logo)
    // Swap cobalt and white without changing the original edges or alpha.
    .linear([-1, -1, 0], [261, 326, 255])
    .png()
    .toBuffer());

export async function socialCardImageResponse(
  request: Request,
  product: ProductDto,
  requestedColor: string,
) {
  const baseProductSlug = baseProductSlugForId(product.baseProductId);
  if (
    !baseProductSlug ||
    !product.designId ||
    !product.designRevisionId ||
    !product.placement
  ) {
    return undefined;
  }

  const color = resolveSocialCardColor(baseProductSlug, requestedColor);
  const productImageUrl = new URL(
    productImagePath({
      baseProductSlug,
      color,
      designId: product.designId,
      productId: product.id,
      revision: product.designRevisionId,
    }),
    request.url,
  );
  const imageSignal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  const fetchProductImage = () => fetch(productImageUrl, {
    cache: "no-store",
    signal: imageSignal,
  });
  let productImageResponse = await fetchProductImage();
  // The image service can accept a render before its bytes are ready. A 202
  // has no image body, so wait briefly instead of passing it to the decoder.
  for (let attempt = 1; productImageResponse.status === 202 && attempt < 5; attempt++) {
    await productImageResponse.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    productImageResponse = await fetchProductImage();
  }
  if (productImageResponse.status === 202) {
    await productImageResponse.body?.cancel();
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": CACHE_CONTROL, "Retry-After": "2" },
    });
  }
  if (productImageResponse.status !== 200) {
    throw new Error("The configured product image is unavailable.");
  }
  const productImage = await sharp(
    new Uint8Array(await productImageResponse.arrayBuffer()),
  ).png().toBuffer();
  const productImageSource = `data:image/png;base64,${productImage.toString("base64")}`;
  const layout = socialCardLayout(SOCIAL_CARD_SETTINGS);
  const [regularFont, boldFont, logo] = await Promise.all([
    geistMonoRegular,
    geistMonoBold,
    inverseLogo,
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          background: COBALT,
          display: "flex",
          fontFamily: SOCIAL_CARD_FONT_FAMILY,
          height: "100%",
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            background: WHITE,
            display: "flex",
            height: layout.innerHeight,
            left: layout.productPanelX,
            position: "absolute",
            top: SOCIAL_CARD_SETTINGS.borderWidth,
            width: layout.productPanelWidth,
          }}
        />
        <div
          style={{
            alignItems: "flex-start",
            color: WHITE,
            display: "flex",
            flexDirection: "column",
            left: layout.textX,
            lineHeight: 1,
            position: "absolute",
            top: layout.textBlockTop,
          }}
        >
          {/* ImageResponse renders native image elements rather than next/image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            height={SOCIAL_CARD_SETTINGS.logoSize}
            src={`data:image/png;base64,${logo.toString("base64")}`}
            style={{ marginBottom: SOCIAL_CARD_SETTINGS.logoGap }}
            width={SOCIAL_CARD_SETTINGS.logoSize}
          />
          <div
            style={{
              display: "flex",
              fontSize: SOCIAL_CARD_SETTINGS.titleSize,
              fontWeight: 700,
              letterSpacing: -3,
            }}
          >
            make your own
          </div>
          <div
            style={{
              display: "flex",
              fontSize: SOCIAL_CARD_SETTINGS.domainSize,
              marginTop: SOCIAL_CARD_SETTINGS.titleGap,
            }}
          >
            shop.bent.build
          </div>
        </div>
        {/* ImageResponse renders native image elements rather than next/image. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          height={layout.renderedProductScale}
          src={productImageSource}
          style={{
            height: layout.renderedProductScale,
            left: layout.productX,
            objectFit: "contain",
            position: "absolute",
            top: layout.productY,
            width: layout.renderedProductScale,
          }}
          width={layout.renderedProductScale}
        />
      </div>
    ),
    {
      headers: {
        "Cache-Control": CACHE_CONTROL,
        "CDN-Cache-Control": CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
      fonts: [
        {
          data: regularFont,
          name: SOCIAL_CARD_FONT_FAMILY,
          style: "normal",
          weight: 400,
        },
        {
          data: boldFont,
          name: SOCIAL_CARD_FONT_FAMILY,
          style: "normal",
          weight: 700,
        },
      ],
      height: SOCIAL_CARD_HEIGHT,
      width: SOCIAL_CARD_WIDTH,
    },
  );
}
