import { defineConfig } from "@playwright/test";
import local from "./playwright.local.config";

const mobile = local.projects?.find(
  (project) => project.name === "local-mobile",
);
if (!mobile)
  throw new Error("The Shop smoke check requires the local mobile project");

// One real UI journey: consent, upload, product selection, cart and readiness.
// Keep its fixture-only upstreams and mobile branch from the full regression.
export default defineConfig({
  ...local,
  grep: /unfinished photo reaches both products and the cart while only checkout waits/,
  projects: [mobile],
});
