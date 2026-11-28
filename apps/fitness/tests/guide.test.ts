import { expect, test } from "bun:test";
import { assistantGuide } from "../src/server/guide";
import { setUpTraining } from "../src/server/mcp";

test("the assistant guide names the endpoint and the set-up steps", () => {
  const guide = assistantGuide("https://fitness.bent.build/api/mcp");
  expect(guide).toStartWith("# Fitness\n\n> ");
  expect(guide).toContain("`https://fitness.bent.build/api/mcp`");
  expect(guide).toContain(
    "claude mcp add --transport http fitness https://fitness.bent.build/api/mcp",
  );
  expect(guide).toContain("https://fitness.bent.build/proposal");
  // The guide's steps use the tools and prompt the server registers.
  for (const name of [
    "set_up_training",
    "fitness_get_training_plan",
    "fitness_list_exercises",
    "fitness_propose_plan",
  ])
    expect(guide).toContain(`\`${name}\``);
  for (const tool of setUpTraining.match(/fitness_[a-z_]+/g) ?? [])
    expect(guide).toContain(tool);
});

test("the guide follows the configured endpoint", () => {
  const guide = assistantGuide("http://127.0.0.1:3025/api/mcp");
  expect(guide).toContain("`http://127.0.0.1:3025/api/mcp`");
  expect(guide).toContain("http://127.0.0.1:3025/account/api-keys");
  expect(assistantGuide(null)).toContain(
    "`https://fitness.bent.build/api/mcp`",
  );
});
