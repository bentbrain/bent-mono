import type { Metadata } from "next";

import {
  productProjectionSpecification,
  type BaseProductSlug,
} from "@forever-tee/contracts/product-projection";

export interface SocialCardSettings {
  readonly borderWidth: number;
  readonly domainSize: number;
  readonly logoGap: number;
  readonly logoSize: number;
  readonly panelWidth: number;
  readonly padding: number;
  readonly productInset: number;
  readonly productScale: number;
  readonly titleGap: number;
  readonly titleSize: number;
}

export const SOCIAL_CARD_WIDTH = 1_200;
export const SOCIAL_CARD_HEIGHT = 630;
const SOCIAL_CARD_VERSION = "v4";
export const SOCIAL_CARD_DESCRIPTION =
  "Make your own shirt or tote from a photo.";
export const SOCIAL_CARD_SETTINGS: SocialCardSettings = {
  borderWidth: 60,
  domainSize: 30,
  logoGap: 16,
  logoSize: 60,
  panelWidth: 560,
  padding: 52,
  productInset: 24,
  productScale: 600,
  titleGap: 24,
  titleSize: 54,
};

export function socialCardLayout(settings: SocialCardSettings) {
  const innerWidth = SOCIAL_CARD_WIDTH - settings.borderWidth * 2;
  const innerHeight = SOCIAL_CARD_HEIGHT - settings.borderWidth * 2;
  const textBlockTop = settings.borderWidth + (
    innerHeight - settings.logoSize - settings.logoGap - settings.titleSize -
    settings.titleGap - settings.domainSize
  ) / 2;
  const panelX = settings.borderWidth;
  const productPanelX = panelX + settings.panelWidth;
  const productPanelWidth = innerWidth - settings.panelWidth;
  const productX = panelX + settings.panelWidth + settings.productInset;
  const productAreaWidth = SOCIAL_CARD_WIDTH - settings.borderWidth - productX;
  const renderedProductScale = Math.min(
    settings.productScale,
    productAreaWidth,
    innerHeight,
  );
  const productY = settings.borderWidth + (
    innerHeight - renderedProductScale
  ) / 2;

  return {
    innerHeight,
    innerWidth,
    panelX,
    productPanelWidth,
    productPanelX,
    productX,
    productY,
    renderedProductScale,
    textBlockTop,
    textX: panelX + settings.padding,
  };
}

export function requestedSocialCardColor(
  query: Record<string, string | string[] | undefined>,
  name: string,
  defaultColor = "Black",
) {
  const value = firstQueryValue(query[name])?.trim();
  if (!value || !/^[a-z -]{1,24}$/i.test(value)) return defaultColor;
  return value;
}

export function resolveSocialCardColor(
  baseProductSlug: BaseProductSlug,
  requestedColor: string,
) {
  const colors = productProjectionSpecification(baseProductSlug).colors;
  return colors.find(
    (color) => color.toLowerCase() === requestedColor.toLowerCase(),
  ) ?? colors.find((color) => color.toLowerCase() === "black") ??
    colors[0] ?? "Black";
}

export function socialCardProductName(baseProductSlug: BaseProductSlug) {
  return baseProductSlug === "staple-tee" ? "T-shirt" : "tote bag";
}

export function productSocialCardPath(productId: string, color: string) {
  return socialCardPath("product", productId, color);
}

export function featuredSocialCardPath(
  baseProductSlug: BaseProductSlug,
  color: string,
) {
  return socialCardPath("featured", baseProductSlug, color);
}

export function createSocialCardMetadata({
  alt,
  canonicalPath,
  documentTitle,
  imagePath,
  sharePath,
}: {
  alt: string;
  canonicalPath: string;
  documentTitle: string;
  imagePath: string;
  sharePath: string;
}): Metadata {
  const image = {
    alt,
    height: SOCIAL_CARD_HEIGHT,
    type: "image/png",
    url: imagePath,
    width: SOCIAL_CARD_WIDTH,
  };

  return {
    alternates: { canonical: canonicalPath },
    description: SOCIAL_CARD_DESCRIPTION,
    openGraph: {
      description: SOCIAL_CARD_DESCRIPTION,
      images: [image],
      locale: "en_AU",
      siteName: "bent.shop",
      title: "make your own",
      type: "website",
      url: sharePath,
    },
    title: documentTitle,
    twitter: {
      card: "summary_large_image",
      description: SOCIAL_CARD_DESCRIPTION,
      images: [{ alt, url: imagePath }],
      title: "make your own",
    },
  };
}

function socialCardPath(
  kind: "featured" | "product",
  id: string,
  color: string,
) {
  return [
    "",
    "api",
    "social-card",
    SOCIAL_CARD_VERSION,
    kind,
    encodeURIComponent(id),
    `${encodeURIComponent(color.toLowerCase())}.png`,
  ].join("/");
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
