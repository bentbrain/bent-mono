import { gql, type StorefrontApi } from "@shopify/hydrogen";

export const PRODUCT_QUERY = gql(`
  query ForeverTeeProduct(
    $handle: String!
    $selectedOptions: [SelectedOptionInput!]!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    product(handle: $handle) {
      id
      handle
      title
      vendor
      requiresSellingPlan
      encodedVariantExistence
      encodedVariantAvailability
      options {
        name
        optionValues {
          name
          firstSelectableVariant {
            id
            title
            availableForSale
            selectedOptions { name value }
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            product { handle title }
            sku
          }
          swatch { color image { previewImage { url } } }
        }
      }
      selectedOrFirstAvailableVariant(
        selectedOptions: $selectedOptions
        ignoreUnknownOptions: true
        caseInsensitiveMatch: true
      ) {
        id
        title
        availableForSale
        selectedOptions { name value }
        price { amount currencyCode }
        compareAtPrice { amount currencyCode }
        product { handle title }
        sku
      }
      variants(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          title
          availableForSale
          selectedOptions { name value }
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          product { handle title }
          sku
        }
      }
      priceRange {
        minVariantPrice { amount currencyCode }
      }
    }
  }
`);

type ProductQuery = StorefrontApi.ResultOf<typeof PRODUCT_QUERY>;
export type QueriedProductData = NonNullable<ProductQuery["product"]>;

export type ProductData = Omit<QueriedProductData, "variants"> & {
  adjacentVariants: QueriedProductData["variants"]["nodes"];
};
