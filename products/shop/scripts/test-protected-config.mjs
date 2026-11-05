// Synthetic identities for local unit tests and fixture builds only. This file
// is never a source of configuration for a deployed application or release.
import fixtures from "./protected-config.fixtures.json" with { type: "json" };
if (!process.env.SHOP_PROTECTED_CONFIG_JSON) {
  process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(fixtures);
}
