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
    staleTools?: Map<string, Tool>;
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
    .poll(() => page.evaluate((key) => !!window.webmcpTools?.has(key), name))
    .toBe(true);
  return page.evaluate(
    ([key, value]) => window.webmcpTools?.get(key)?.execute(value),
    [name, input] as const,
  );
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
    for (const user of users) {
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
    ["/food", ["Add food"]],
    ["/progress", ["Sessions", "Bodyweight"]],
    ["/history", ["Overview"]],
    ["/body", ["Save weigh-in"]],
    ["/settings", ["Save settings", "Export account data and photos"]],
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
  await page.evaluate(() => {
    window.staleTools = new Map(window.webmcpTools);
    const snapshot = window.webmcpTools?.get("snapshot");
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

  // Signing in again in this page registers tools under new names, so a
  // handle that looks a tool up by its earlier name can't reach them.
  await clerk.signIn({ page, emailAddress: email });
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect
    .poll(() =>
      page.evaluate(() => [...(window.webmcpTools?.keys() ?? [])].sort()),
    )
    .toEqual(["act_1", "query_1", "snapshot_1"]);
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
    window.cancelled = window.webmcpTools
      ?.get("act")
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
