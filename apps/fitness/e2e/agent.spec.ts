import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import postgres from "postgres";
import { z } from "zod";
import { settleWrites, trackWrites } from "./quiescence";

const email = "fitness-a+clerk_test@example.com";
const entrySchema = z.object({
  ref: z.string(),
  component: z.string(),
  label: z.string().optional(),
  offPage: z.boolean().optional(),
  confirm: z.string().optional(),
});
const actSchema = z.object({
  ok: z.boolean(),
  error: z.object({ step: z.number(), message: z.string() }).optional(),
});
type Tool = {
  execute: (
    input: object,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown> | unknown;
};
declare global {
  interface Window {
    webmcpTools?: Map<string, Tool>;
    findTool?: (base: string) => Tool | undefined;
    staleTools?: Map<string, Tool | undefined>;
    firstSignedOutSnapshot?: Promise<unknown> | unknown;
    cancelled?: Promise<unknown> | unknown;
    cancel?: () => void;
  }
}

/** Stands in for a browser's WebMCP API, so the test calls the tools the app registers. */
async function installModelContext(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, Tool>();
    window.webmcpTools = tools;
    // The app suffixes each registration's names, like `snapshot_3f9c2a1b`.
    window.findTool = (base) =>
      [...tools].find(([name]) => name.startsWith(`${base}_`))?.[1];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (
          tool: Tool & { name: string },
          options?: { signal?: AbortSignal },
        ) => {
          tools.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => {
            if (tools.get(tool.name) === tool) tools.delete(tool.name);
          });
        },
        unregisterTool: async (name: string) => {
          tools.delete(name);
        },
      },
    });
  });
}
async function tool(page: Page, name: string, input: object = {}) {
  await expect
    .poll(() => page.evaluate((key) => !!window.findTool?.(key), name))
    .toBe(true);
  return page.evaluate(
    ([key, value]) => window.findTool?.(key)?.execute(value),
    [name, input] as const,
  );
}
function toolNames(page: Page) {
  return page.evaluate(() => [...(window.webmcpTools?.keys() ?? [])].sort());
}
async function snapshot(page: Page) {
  return z
    .array(entrySchema)
    .parse(await tool(page, "snapshot"))
    .filter((entry) => !entry.offPage && entry.component !== "more");
}
function act(page: Page, steps: object[]) {
  return tool(page, "act", { steps }).then((result) => actSchema.parse(result));
}

test.beforeAll(async () => {
  await clerkSetup({ publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY });
});
test.beforeEach(async ({ page, context }) => {
  trackWrites(context);
  page.setDefaultTimeout(10000);
  const secret = process.env.CLERK_SECRET_KEY;
  const url = process.env.DATABASE_URL;
  if (!secret?.startsWith("sk_test_") || !url)
    throw Error("Dedicated development configuration is required");
  const response = await fetch(
    "https://api.clerk.com/v1/users?email_address=" + encodeURIComponent(email),
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  if (!response.ok) throw Error("Synthetic account lookup failed");
  const users = z
    .array(z.object({ id: z.string() }))
    .parse(await response.json());
  const sql = postgres(url, { ssl: "verify-full", max: 1, prepare: false });
  try {
    // Plan proposals reference the account. Databases that haven't had
    // the proposals table applied yet have none to remove.
    const [{ proposals }] =
      await sql`SELECT to_regclass('fitness_plan_proposals') IS NOT NULL AS proposals`;
    for (const user of users) {
      if (proposals)
        await sql`DELETE FROM fitness_plan_proposals WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_photos WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_operations WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_records WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_accounts WHERE owner_id=${user.id}`;
    }
  } finally {
    await sql.end();
  }
  await installModelContext(page);
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const setup = page.getByRole("button", { name: "Set up my plan" });
  if (await setup.isVisible()) await setup.click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
});
test.afterEach(async ({ context }) => {
  await settleWrites(context);
});

test("an agent finds every control by name on each screen", async ({
  page,
}) => {
  const screens: [string, string[]][] = [
    ["/", ["Week", "Exercises", "Food", "Progress", "Settings"]],
    ["/guides", ["Goblet squat"]],
    ["/food", ["Add food", "Meal or snack", "Save as a regular meal"]],
    ["/progress", ["Sessions", "Bodyweight"]],
    ["/history", ["Overview"]],
    ["/body", ["Save weigh-in"]],
    [
      "/settings",
      [
        "Save settings",
        "Export account data and photos",
        "Goal",
        "Display units",
      ],
    ],
    ["/schedule", ["Save settings"]],
  ];
  for (const [path, expected] of screens) {
    await page.goto(path);
    await expect(page.locator(".sync-state")).toHaveText("Saved");
    const entries = await snapshot(page);
    for (const entry of entries)
      expect(
        entry.label,
        `${path}: ${entry.component} ${entry.ref} has no name`,
      ).toBeTruthy();
    const labels = entries.map((entry) => entry.label ?? "");
    for (const label of expected)
      expect(
        labels.some((name) => name.startsWith(label)),
        `${path}: ${label} is missing from the snapshot`,
      ).toBe(true);
  }
});

test("an agent moves between sections by pressing links", async ({ page }) => {
  const press = await act(page, [{ ref: "Food", action: "press" }]);
  expect(press.ok, press.error?.message).toBe(true);
  await expect(page).toHaveURL(/\/food$/);
  await expect(
    page.getByRole("link", { name: "Food", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const settings = await act(page, [{ ref: "Settings", action: "press" }]);
  expect(settings.ok, settings.error?.message).toBe(true);
  await expect(page).toHaveURL(/\/settings$/);
});

test("an agent's export waits for the person to allow it", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const exportLabel = "Export account data and photos";
  const marked = (await snapshot(page)).find(
    (entry) => entry.label === exportLabel,
  );
  expect(marked?.confirm).toBe(
    "Downloads a copy of all your Fitness data and photos to this device",
  );
  const step = [{ ref: exportLabel, action: "press" }];
  const ask = page.getByRole("alertdialog", {
    name: "Allow your assistant to do this?",
  });

  const refused = act(page, step);
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(
    "Downloads a copy of all your Fitness data and photos to this device",
  );
  expect(
    (await snapshot(page)).some((entry) => entry.label === "Allow"),
    "the confirmation is hidden from the agent",
  ).toBe(false);
  await ask.getByRole("button", { name: "Not now" }).click();
  expect((await refused).ok).toBe(false);
  await expect(ask).toBeHidden();

  const download = page.waitForEvent("download");
  const allowed = act(page, step);
  await ask.getByRole("button", { name: "Allow" }).click();
  expect((await allowed).ok).toBe(true);
  expect((await download).suggestedFilename()).toBe("fitness-export.json");
});

test("signing out ends the agent's access to the page", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const ask = page.getByRole("alertdialog", {
    name: "Allow your assistant to do this?",
  });
  const waiting = tool(page, "act", {
    steps: [{ ref: "Export account data and photos", action: "press" }],
  });
  await expect(ask).toBeVisible();
  const queued = tool(page, "query", { text: "Sign in" });
  const earlier = await toolNames(page);
  await page.evaluate(() => {
    window.staleTools = new Map(
      ["act", "query", "snapshot"].map((base) => [
        base,
        window.findTool?.(base),
      ]),
    );
    const snapshot = window.findTool?.("snapshot");
    // Reads the earlier registration the moment the signed-out page appears.
    const watcher = new MutationObserver(() => {
      const signIn = [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Sign in",
      );
      if (!signIn) return;
      watcher.disconnect();
      window.firstSignedOutSnapshot = snapshot?.execute({});
    });
    watcher.observe(document.body, { childList: true, subtree: true });
  });
  await clerk.signOut({ page });
  expect(await waiting).toMatchObject({
    ok: false,
    appeared: [],
    values: {},
  });
  expect(await queued).toHaveProperty("error");
  await expect(ask).toBeHidden();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(await page.evaluate(() => window.webmcpTools?.size)).toBe(0);
  expect(await page.evaluate(() => window.firstSignedOutSnapshot)).toEqual([]);

  const stale = (name: string, input: object) =>
    page.evaluate(
      ([key, value]) => window.staleTools?.get(key)?.execute(value),
      [name, input] as const,
    );
  expect(await stale("snapshot", {})).toEqual([]);
  expect(await stale("query", { text: "Sign in" })).toHaveProperty("error");
  const late = actSchema.parse(
    await stale("act", { steps: [{ ref: "Sign in", action: "press" }] }),
  );
  expect(late.ok, "a call made through the earlier registration").toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors.filter((text) => text.includes("useInsertionEffect"))).toEqual(
    [],
  );

  // Signing in again registers tools under new names, so a handle that looks
  // a tool up by its earlier name can't reach them.
  await clerk.signIn({ page, emailAddress: email });
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const later = await toolNames(page);
  expect(later.filter((name) => earlier.includes(name))).toEqual([]);
});

test("each page load registers tools under names of its own", async ({
  page,
}) => {
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const first = await toolNames(page);
  for (const name of first)
    expect(name).toMatch(/^(act|query|snapshot)_[0-9a-f]{32}$/);
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const second = await toolNames(page);
  expect(second.filter((name) => first.includes(name))).toEqual([]);
});

test("an agent's marked step is refused while a native modal is open", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.evaluate(() => {
    const modal = document.createElement("dialog");
    modal.textContent = "Another sheet";
    document.body.append(modal);
    modal.showModal();
  });
  const result = await act(page, [
    { ref: "Export account data and photos", action: "press" },
  ]);
  expect(result.ok).toBe(false);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("a cancelled agent call closes its question", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect
    .poll(() => page.evaluate(() => window.webmcpTools?.size))
    .toBe(3);
  await page.evaluate(() => {
    const controller = new AbortController();
    window.cancel = () => controller.abort();
    window.cancelled = window
      .findTool?.("act")
      ?.execute(
        { steps: [{ ref: "Export account data and photos", action: "press" }] },
        { signal: controller.signal },
      );
  });
  const ask = page.getByRole("alertdialog", {
    name: "Allow your assistant to do this?",
  });
  await expect(ask).toBeVisible();
  await page.evaluate(() => window.cancel?.());
  await expect(ask).toBeHidden();
  expect(actSchema.parse(await page.evaluate(() => window.cancelled)).ok).toBe(
    false,
  );
});

test("an agent step with fields it doesn't take is refused", async ({
  page,
}) => {
  const result = await act(page, [
    { ref: "Food", action: "press" },
    { ref: "Food", action: "press", value: "Food" },
  ]);
  expect(result.ok).toBe(false);
  expect(result.error?.step).toBe(1);
  expect(result.error?.message).toContain("put values in args");
  await expect(page).toHaveURL(/\/$/);
  expect(await tool(page, "query", { name: "Food" })).toEqual({
    error: expect.stringContaining("A query takes text"),
  });
});

test("the account opens without WebMCP or AbortSignal.any", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Reflect.deleteProperty(document, "modelContext");
    Reflect.deleteProperty(AbortSignal, "any");
  });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  expect(await page.evaluate(() => "any" in AbortSignal)).toBe(false);
  expect(errors).toEqual([]);
});

test("a cancelled agent call reports the steps it finished", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const equipment = page.getByRole("button", { name: "Remove equipment" });
  const before = await equipment.count();
  await page.evaluate(() => {
    const controller = new AbortController();
    window.cancel = () => controller.abort();
    window.cancelled = window.findTool?.("act")?.execute(
      {
        steps: [
          { ref: "Add equipment", action: "press" },
          { ref: "Export account data and photos", action: "press" },
        ],
      },
      { signal: controller.signal },
    );
  });
  const ask = page.getByRole("alertdialog", {
    name: "Allow your assistant to do this?",
  });
  await expect(ask).toBeVisible();
  await page.evaluate(() => window.cancel?.());
  await expect(ask).toBeHidden();
  const result = z
    .object({
      ok: z.boolean(),
      steps: z.array(z.unknown()),
      error: z.object({ step: z.number() }).optional(),
    })
    .parse(await page.evaluate(() => window.cancelled));
  expect(result.ok).toBe(false);
  expect(result.error?.step).toBe(1);
  expect(result.steps).toHaveLength(1);
  await expect(equipment).toHaveCount(before + 1);
});

test("tool names stay distinct when ids share a prefix", async ({ page }) => {
  await page.addInitScript(() => {
    const random = crypto.randomUUID.bind(crypto);
    // Every id this page makes starts the same way, as two can by chance.
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => `aaaaaaaa${random().slice(8)}`,
    });
  });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const first = await toolNames(page);
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect.poll(async () => (await toolNames(page)).length).toBe(3);
  const second = await toolNames(page);
  expect(second.filter((name) => first.includes(name))).toEqual([]);
});

test("an agent tells saved meals with the same name apart", async ({
  page,
}) => {
  await page.goto("/food");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  for (const protein of ["12.1", "12.4"]) {
    await page.getByLabel("Meal or snack").fill("Oats");
    await page.getByLabel("Calories · kcal").fill("350");
    await page.getByLabel("Protein · g", { exact: true }).fill(protein);
    await page.getByLabel("Save as a regular meal").check();
    await page.getByRole("button", { name: "Add food", exact: true }).click();
    await expect(page.locator(".sync-state")).toHaveText("Saved");
  }
  const quickAdds = (await snapshot(page)).filter((entry) =>
    /^Add saved meal \d+: Oats to /.test(entry.label ?? ""),
  );
  expect(quickAdds.map((entry) => entry.label?.split(", ").at(-1))).toEqual([
    "12.1g protein",
    "12.4g protein",
  ]);
  const richer = quickAdds.find((entry) =>
    entry.label?.endsWith("12.4g protein"),
  );
  const result = await act(page, [{ ref: richer?.ref ?? "", action: "press" }]);
  expect(result.ok, result.error?.message).toBe(true);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const meals = z
    .object({ records: z.array(z.object({ data: z.looseObject({}) })) })
    .parse(await (await page.request.get("/api/export")).json())
    .records.map((record) => record.data)
    .filter((data) => data.kind === "meal" && data.name === "Oats");
  expect(meals.filter((data) => data.protein === 12.4)).toHaveLength(2);
  expect(meals.filter((data) => data.protein === 12.1)).toHaveLength(1);
});

test("an agent fills in and submits the food form", async ({ page }) => {
  await page.goto("/food");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const result = await act(page, [
    { ref: "Meal or snack", action: "setValue", args: ["Agent porridge"] },
    { ref: "Calories · kcal", action: "setValue", args: ["320"] },
    { ref: "Protein · g", action: "setValue", args: ["11"] },
    { ref: "Save as a regular meal", action: "setChecked", args: [true] },
    { ref: "Add food", action: "press" },
  ]);
  expect(result.ok, result.error?.message).toBe(true);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect(page.locator(".food-screen > .entries .list-row")).toContainText(
    "Agent porridge",
  );
  await expect(
    page.getByRole("button", { name: /^Add saved meal \d+: Agent porridge/ }),
  ).toHaveCount(1);
});

test("an agent changes settings and saves them", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const result = await act(page, [
    { ref: "Goal", action: "setValue", args: ["Agent-set goal"] },
    { ref: "Display units", action: "setValue", args: ["Pounds"] },
    { ref: "Save settings", action: "press" },
  ]);
  expect(result.ok, result.error?.message).toBe(true);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByLabel("Goal", { exact: true })).toHaveValue(
    "Agent-set goal",
  );
  await expect(
    page
      .getByRole("radiogroup", { name: "Display units" })
      .getByRole("radio", { name: "Pounds" }),
  ).toHaveAttribute("aria-checked", "true");
});
