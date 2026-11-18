import { test, expect } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { mkdir } from "node:fs/promises";
import postgres from "postgres";
import { z } from "zod";
import { recordSchema } from "../src/domain";
const email = "fitness-a+clerk_test@example.com";
const exportSchema = z.object({ records: z.array(recordSchema) });
test.beforeAll(async () => {
  await clerkSetup({ publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY });
});
test.beforeEach(async ({ page }) => {
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
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const setup = page.getByRole("button", { name: "Set up my plan" });
  if (await setup.isVisible()) await setup.click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Plan start date").fill("2026-01-05");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Today", exact: true })
    .click();
  await page.locator("#view-date").fill("2026-01-05");
});
test("plan preview is read-only and browser back returns to Today", async ({
  page,
}, info) => {
  await mkdir("private/screenshots", { recursive: true });
  await page.getByRole("heading", { name: "Keep showing up." }).click();
  await page.screenshot({
    path: `private/screenshots/today-preview-${info.project.name}.png`,
    fullPage: true,
  });
  const before = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plan\/2026-01-05\//);
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".plan-exercise")).toHaveCount(6);
  await expect(page.getByRole("timer")).toHaveCount(0);
  await expect(
    page.locator(".plan-exercise").filter({ hasText: "Supported one-arm row" }),
  ).toContainText("2 × 10–15 reps / side");
  await expect(
    page.locator(".plan-exercise").filter({ hasText: "Forearm plank" }),
  ).toContainText("2 × 20–40 seconds");
  await expect(
    page.getByRole("button", { name: "Start workout", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `private/screenshots/workout-plan-${info.project.name}.png`,
    fullPage: true,
  });
  const after = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  expect(after.records).toEqual(before.records);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page.goto("/plan/not-a-date/missing");
  await expect(
    page.getByRole("heading", { name: "Plan unavailable" }),
  ).toBeVisible();
  const final = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  expect(final.records).toEqual(before.records);
});
test("main navigation creates browser history entries and preserves the selected date", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/food\?date=2026-01-05/);
  await expect(
    page.getByRole("navigation").locator("[aria-current=page]"),
  ).toHaveText("+Food");
  await page.reload();
  await expect(page.getByLabel("Meal or snack")).toBeVisible();
  await page.locator("#view-date").fill("2026-01-06");
  await expect(page).toHaveURL(/\/food\?date=2026-01-06/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  await expect(page.locator("#view-date")).toHaveValue("2026-01-05");
  await page.goForward();
  await expect(page.getByLabel("Meal or snack")).toBeVisible();
  await expect(page.locator("#view-date")).toHaveValue("2026-01-06");
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Open exercise guides" }).click();
  await expect(page).toHaveURL(/\/guides/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
});
test("starting a workout runs elapsed time and preserves timers and draft across navigation", async ({
  page,
}, info) => {
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start workout", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workouts\//);
  const url = page.url();
  const elapsed = page.getByRole("timer", {
    name: "Workout elapsed time",
    exact: true,
  });
  await expect(elapsed).toBeVisible();
  const initial = await elapsed.locator("strong").textContent();
  await expect
    .poll(() => elapsed.locator("strong").textContent())
    .not.toBe(initial);
  const rest = page.getByRole("timer", { name: "Rest timer", exact: true });
  await expect(rest).toContainText("Not running");
  await page.screenshot({
    path: `private/screenshots/workout-timer-${info.project.name}.png`,
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Start 2:00 rest", exact: true })
    .click();
  await expect(rest).not.toContainText("Not running");
  await page.screenshot({
    path: `private/screenshots/workout-rest-running-${info.project.name}.png`,
  });
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.reload();
  await expect(rest).not.toContainText("Not running");
  await page.getByRole("button", { name: "Skip rest", exact: true }).click();
  await expect(rest).toContainText("Not running");
  await page
    .getByRole("button", { name: "Goblet squat set 1 complete", exact: true })
    .click();
  await expect(rest).not.toContainText("Not running");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const before = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  await page.getByRole("link", { name: "Back to Today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start workout", exact: true }),
  ).toHaveCount(0);
  const after = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  expect(after.records).toEqual(before.records);
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("button", {
      name: "Goblet squat set 1 completed",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Discard this workout", { exact: true }).click();
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Resume workout", exact: true }),
  ).toHaveCount(0);
});

test("finishing a workout opens history and browser Back keeps it completed", async ({
  page,
}) => {
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start workout", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workouts\//);
  const workoutUrl = page.url();
  const sets = page.getByRole("button", { name: / set \d+ complete$/ });
  await expect(sets).toHaveCount(12);
  const count = await sets.count();
  for (let index = 0; index < count; index++) await sets.first().click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await expect(page).toHaveURL(/\/history/);
  await expect(page.locator(".sync-state")).toHaveText("Saved", {
    timeout: 20000,
  });
  await page.goBack();
  await expect(page).toHaveURL(workoutUrl);
  await expect(
    page.getByRole("heading", { name: "Workout completed", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Workout completed", exact: true }),
  ).toBeVisible();
});
