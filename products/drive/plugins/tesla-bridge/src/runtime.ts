import { ActionStore } from "./action-store.js";
import { loadConfig } from "./config.js";
import { createTeslaAdapter } from "./tesla-adapter.js";

export function createRuntime() {
  const config = loadConfig();
  return {
    config,
    adapter: createTeslaAdapter(config),
    actionStore: new ActionStore(),
  };
}
