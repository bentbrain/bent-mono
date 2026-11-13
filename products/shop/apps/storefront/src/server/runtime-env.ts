import "@tanstack/react-start/server-only";
import { env as bindings } from "cloudflare:workers";
import { Schema } from "effect";

const Bindings = Schema.Struct({
  FOREVER_TEE_API_URL: Schema.String,
  FOREVER_TEE_API_SHARED_SECRET: Schema.NonEmptyString,
  TURNSTILE_SECRET: Schema.NonEmptyString,
  TURNSTILE_SITE_KEY: Schema.NonEmptyString,
  PUBLIC_STORE_DOMAIN: Schema.NonEmptyString,
  PUBLIC_STOREFRONT_API_TOKEN: Schema.NonEmptyString,
  PRIVATE_STOREFRONT_API_TOKEN: Schema.NonEmptyString,
  SHOP_ID: Schema.optional(Schema.String),
  PUBLIC_STOREFRONT_ID: Schema.optional(Schema.String),
});

export function runtimeEnv() {
  const value = Schema.decodeUnknownSync(Bindings)(bindings);
  const url = new URL(value.FOREVER_TEE_API_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "The design service requires an HTTPS origin or a local loopback origin.",
    );
  }
  return value;
}

// Every value is read at request time from Worker bindings, never Vite defines.
export const env = {
  get FOREVER_TEE_API_URL() {
    return runtimeEnv().FOREVER_TEE_API_URL;
  },
  get FOREVER_TEE_API_SHARED_SECRET() {
    return runtimeEnv().FOREVER_TEE_API_SHARED_SECRET;
  },
  get TURNSTILE_SECRET() {
    return runtimeEnv().TURNSTILE_SECRET;
  },
  get PUBLIC_STORE_DOMAIN() {
    return runtimeEnv().PUBLIC_STORE_DOMAIN;
  },
  get PUBLIC_STOREFRONT_API_TOKEN() {
    return runtimeEnv().PUBLIC_STOREFRONT_API_TOKEN;
  },
  get PRIVATE_STOREFRONT_API_TOKEN() {
    return runtimeEnv().PRIVATE_STOREFRONT_API_TOKEN;
  },
  get SHOP_ID() {
    return runtimeEnv().SHOP_ID;
  },
  get PUBLIC_STOREFRONT_ID() {
    return runtimeEnv().PUBLIC_STOREFRONT_ID;
  },
};
