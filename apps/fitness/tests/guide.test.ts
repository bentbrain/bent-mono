import { expect, test } from "bun:test";
import { assistantEndpoint, publicEndpoint } from "../src/server/config";
import { assistantGuide } from "../src/server/guide";
import { setUpTraining } from "../src/server/mcp";

const resource = "https://fitness.bent.build/api/mcp";

test("with plan access the guide walks an assistant through setting up training", () => {
  const guide = assistantGuide({ resource, planning: true });
  expect(guide).toStartWith("# Fitness\n\n> ");
  expect(guide).toContain(`\`${resource}\``);
  expect(guide).toContain(
    `claude mcp add --transport http fitness ${resource}`,
  );
  expect(guide).toContain("https://fitness.bent.build/proposal");
  expect(guide).toContain("If `plan` is `null`");
  expect(guide).toContain("Set up my plan");
  expect(guide).toContain("- `fitness:plan`");
  // The guide's steps use the tools and prompt the server registers.
  expect(guide).toContain("`set_up_training`");
  for (const tool of setUpTraining.match(/fitness_[a-z_]+/g) ?? [])
    expect(guide).toContain(`\`${tool}\``);
});

test("without plan access the guide covers connecting only", () => {
  const guide = assistantGuide({ resource, planning: false });
  expect(guide).toContain(`\`${resource}\``);
  expect(guide).not.toContain("fitness_propose_plan");
  expect(guide).not.toContain("fitness:plan");
  expect(guide).not.toContain("set up their training");
});

test("the guide follows the configured endpoint, or says it isn't configured", () => {
  const local = assistantGuide({
    resource: "http://127.0.0.1:3025/api/mcp",
    planning: true,
  });
  expect(local).toContain("`http://127.0.0.1:3025/api/mcp`");
  expect(local).toContain("http://127.0.0.1:3025/account/api-keys");
  expect(local).not.toContain("fitness.bent.build");
  const missing = assistantGuide({ resource: null, planning: true });
  expect(missing).toContain("assistant connection isn't configured");
  expect(missing).not.toContain("/api/mcp");
});

const configKeys = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "FITNESS_ALLOWED_EMAILS",
  "FITNESS_MCP_URL",
] as const;
function withConfig(
  values: Partial<Record<(typeof configKeys)[number], string>>,
  run: () => void,
) {
  const before = Object.fromEntries(
    configKeys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of configKeys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const key of configKeys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const synthetic = {
  DATABASE_URL: "postgres://fitness@127.0.0.1:5432/fitness",
  CLERK_SECRET_KEY: "sk_test_synthetic",
  VITE_CLERK_PUBLISHABLE_KEY:
    "pk_test_" + Buffer.from("example.clerk.accounts.dev$").toString("base64"),
  FITNESS_ALLOWED_EMAILS: "person@example.com",
  FITNESS_MCP_URL: "http://127.0.0.1:3025/api/mcp",
};

test("the guide offers a connection only when assistants can use it", () => {
  withConfig(synthetic, () => {
    expect(assistantEndpoint()).toBe("http://127.0.0.1:3025/api/mcp");
    expect(assistantGuide({ planning: true })).toContain(
      "`http://127.0.0.1:3025/api/mcp`",
    );
  });
  // Account services aren't configured, or the endpoint isn't valid.
  for (const values of [
    { ...synthetic, CLERK_SECRET_KEY: undefined },
    { ...synthetic, FITNESS_MCP_URL: "http://127.0.0.1:3025/api/mcp/" },
  ])
    withConfig(values, () => {
      expect(assistantEndpoint()).toBeNull();
      const guide = assistantGuide({ planning: true });
      expect(guide).toContain("assistant connection isn't configured");
      expect(guide).not.toContain("A person can");
    });
});

test("permissions follow what sign-in can grant, and local endpoints skip hosted apps", () => {
  const without = assistantGuide({ resource, planning: false, targets: false });
  expect(without).not.toContain("fitness:targets");
  expect(without).toContain("changes food targets and proposes training plans");
  const all = assistantGuide({ resource, planning: true, targets: true });
  expect(all).toContain(
    "and log and remove runs.\n- `fitness:targets`: change daily calorie",
  );
  expect(all).toContain("- `fitness:plan`");
  expect(all).toContain("custom connector");
  const local = assistantGuide({
    resource: "http://127.0.0.1:3025/api/mcp",
    planning: true,
  });
  expect(local).toContain("isn't on a public domain name");
  expect(local).toContain("may not reach it directly");
  expect(local).not.toContain("help.openai.com");
});

test("only HTTPS endpoints on public domain names count as public", () => {
  expect(publicEndpoint("https://fitness.bent.build/api/mcp")).toBe(true);
  for (const url of [
    "http://127.0.0.1:3025/api/mcp",
    "http://localhost:3025/api/mcp",
    "http://[::1]:3025/api/mcp",
    "https://127.0.0.2/api/mcp",
    "https://192.168.1.10/api/mcp",
    "https://[fd00::1]/api/mcp",
    "https://localhost/api/mcp",
    "https://fitness.local/api/mcp",
    "https://app.localhost/api/mcp",
    "http://fitness.example.com/api/mcp",
  ])
    expect(publicEndpoint(url)).toBe(false);
});
