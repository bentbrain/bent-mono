import { expect, test } from "bun:test";
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
