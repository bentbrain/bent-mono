import { gql } from "@shopify/hydrogen";

export const CART_FRAGMENT = gql(`
  fragment CartFragment on Cart {
    attributes { key value }
    lines(first: 250) {
      nodes {
        attributes { key value }
        merchandise {
          ... on ProductVariant {
            product {
              options { name optionValues { name } }
              variants(first: 100) {
                nodes {
                  id
                  availableForSale
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }
  }
`);

export const CART_ATTRIBUTES_UPDATE_QUERY = gql(`
  mutation ForeverTeeCartAttributesUpdate(
    $cartId: ID!
    $attributes: [AttributeInput!]!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cartAttributesUpdate(cartId: $cartId, attributes: $attributes) {
      cart {
        id
        attributes { key value }
      }
      userErrors { field message }
      warnings { code message }
    }
  }
`);

export const CART_LINES_VARIANT_UPDATE_QUERY = gql(`
  mutation ForeverTeeCartLineVariantUpdate(
    $cartId: ID!
    $lines: [CartLineUpdateInput!]!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart {
        id
        checkoutUrl
        totalQuantity
        note
        cost {
          subtotalAmount { amount currencyCode }
          totalAmount { amount currencyCode }
          checkoutChargeAmount { amount currencyCode }
        }
        lines(first: 250) {
          nodes {
            id
            quantity
            attributes { key value }
            cost {
              totalAmount { amount currencyCode }
              subtotalAmount { amount currencyCode }
              amountPerQuantity { amount currencyCode }
              compareAtAmountPerQuantity { amount currencyCode }
            }
            merchandise {
              ... on ProductVariant {
                id
                title
                sku
                image { id url altText width height }
                product {
                  id
                  title
                  handle
                  vendor
                  productType
                  options { name optionValues { name } }
                  variants(first: 100) {
                    nodes {
                      id
                      availableForSale
                      selectedOptions { name value }
                    }
                  }
                }
                selectedOptions { name value }
              }
            }
          }
        }
        discountCodes { applicable code }
      }
      userErrors { code field message }
      warnings { code message target }
    }
  }
`);

export const EMPTY_CART_CREATE_QUERY = gql(`
  mutation ForeverTeeEmptyCartCreate(
    $input: CartInput!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cartCreate(input: $input) {
      cart {
        id
        checkoutUrl
        totalQuantity
        note
        cost {
          subtotalAmount { amount currencyCode }
          totalAmount { amount currencyCode }
          checkoutChargeAmount { amount currencyCode }
        }
        lines(first: 250) {
          nodes {
            id
            quantity
            attributes { key value }
            cost {
              totalAmount { amount currencyCode }
              subtotalAmount { amount currencyCode }
              amountPerQuantity { amount currencyCode }
              compareAtAmountPerQuantity { amount currencyCode }
            }
            merchandise {
              ... on ProductVariant {
                id
                title
                sku
                image { id url altText width height }
                product { id title handle vendor productType }
                selectedOptions { name value }
              }
            }
          }
        }
        discountCodes { applicable code }
      }
      userErrors { code field message }
      warnings { code message target }
    }
  }
`);

export const CART_INTEGRITY_QUERY = gql(`
  query ForeverTeeCartIntegrity(
    $cartId: ID!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cart(id: $cartId) {
      id
      totalQuantity
      lines(first: 250) {
        nodes {
          id
          quantity
          attributes { key value }
          merchandise {
            __typename
            ... on ProductVariant { id }
          }
          sellingPlanAllocation { sellingPlan { id } }
        }
      }
    }
  }
`);

export const CART_VARIANT_INTEGRITY_QUERY = gql(`
  query ForeverTeeCartVariantIntegrity(
    $baseHandle: String!
    $merchandiseId: ID!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    baseProduct: product(handle: $baseHandle) { id }
    merchandise: node(id: $merchandiseId) {
      __typename
      ... on ProductVariant {
        id
        availableForSale
        product { id requiresSellingPlan }
        sellingPlanAllocations(first: 250) {
          nodes { sellingPlan { id } }
        }
      }
    }
  }
`);

export const CART_CREATE_QUERY = gql(`
  mutation ForeverTeeCartCreate(
    $input: CartInput!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cartCreate(input: $input) {
      cart {
        id
        lines(first: 250) { nodes { attributes { key value } } }
      }
      userErrors { field message }
      warnings { code message }
    }
  }
`);

export const CART_LINES_ADD_QUERY = gql(`
  mutation ForeverTeeCartLinesAdd(
    $cartId: ID!
    $lines: [CartLineInput!]!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        id
        lines(first: 250) { nodes { attributes { key value } } }
      }
      userErrors { field message }
      warnings { code message }
    }
  }
`);
