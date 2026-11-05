export const STOREFRONT_NAME = "bent.shop";

export function storefrontProductTitle(title: string) {
  return title.trim().toLowerCase() === "bent shirt"
    ? STOREFRONT_NAME
    : title;
}
