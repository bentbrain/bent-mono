import { createEnv } from "@t3-oss/env-nextjs";
import { Schema } from "effect";

const RequiredString = Schema.standardSchemaV1(Schema.NonEmptyString);
const OptionalString = Schema.standardSchemaV1(
  Schema.UndefinedOr(Schema.NonEmptyString),
);
const HttpUrl = Schema.standardSchemaV1(
  Schema.String.pipe(
    Schema.filter(
      (value) => {
        if (!URL.canParse(value)) return false;
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      },
      { message: () => "Expected an HTTP or HTTPS URL" },
    ),
  ),
);
export const env = createEnv({
  server: {
    PUBLIC_STORE_DOMAIN: RequiredString,
    PUBLIC_STOREFRONT_API_TOKEN: RequiredString,
    PRIVATE_STOREFRONT_API_TOKEN: RequiredString,
    FOREVER_TEE_API_URL: HttpUrl,
    FOREVER_TEE_API_SHARED_SECRET: RequiredString,
    TURNSTILE_SECRET: RequiredString,
    TURNSTILE_TEST_MODE: OptionalString,
    LAN_DEV_ORIGIN: OptionalString,
    SHOP_ID: OptionalString,
    PUBLIC_STOREFRONT_ID: OptionalString,
  },
  client: {
    NEXT_PUBLIC_FOREVER_TEE_API_URL: HttpUrl,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: RequiredString,
  },
  runtimeEnv: {
    PUBLIC_STORE_DOMAIN: process.env["PUBLIC_STORE_DOMAIN"],
    PUBLIC_STOREFRONT_API_TOKEN:
      process.env["PUBLIC_STOREFRONT_API_TOKEN"],
    PRIVATE_STOREFRONT_API_TOKEN:
      process.env["PRIVATE_STOREFRONT_API_TOKEN"],
    FOREVER_TEE_API_URL: process.env["FOREVER_TEE_API_URL"],
    FOREVER_TEE_API_SHARED_SECRET:
      process.env["FOREVER_TEE_API_SHARED_SECRET"],
    TURNSTILE_SECRET: process.env["TURNSTILE_SECRET"],
    TURNSTILE_TEST_MODE: process.env["TURNSTILE_TEST_MODE"],
    NEXT_PUBLIC_FOREVER_TEE_API_URL:
      process.env["NEXT_PUBLIC_FOREVER_TEE_API_URL"],
    NEXT_PUBLIC_TURNSTILE_SITE_KEY:
      process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"],
    LAN_DEV_ORIGIN: process.env["LAN_DEV_ORIGIN"],
    SHOP_ID: process.env["SHOP_ID"],
    PUBLIC_STOREFRONT_ID: process.env["PUBLIC_STOREFRONT_ID"],
  },
  emptyStringAsUndefined: true,
});
