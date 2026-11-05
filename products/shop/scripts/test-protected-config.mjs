// Synthetic identities for local unit tests and fixture builds only. This file
// is never a source of configuration for a deployed application or release.
import fixtures from "./protected-config.fixtures.json" with { type: "json" };
if (!process.env.SHOP_PROTECTED_CONFIG_JSON) {
  process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(fixtures);
}

// Synthetic evidence keys only for local tests, never release configuration.
if (!process.env.SHOP_EVIDENCE_ENCRYPTION_KEY) process.env.SHOP_EVIDENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("hex");
if (!process.env.SHOP_EVIDENCE_KEY_VERSION) process.env.SHOP_EVIDENCE_KEY_VERSION = "v1";
