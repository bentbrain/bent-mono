import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { mkdir } from "node:fs/promises";
import postgres from "postgres";
import { z } from "zod";
import {
  addDays,
  mondayOf,
  localDate,
  scheduled,
  recordSchema,
} from "@bent/fitness-contracts/domain";
import { settleWrites, trackWrites } from "./quiescence";
const email = "fitness-a+clerk_test@example.com";
const exportSchema = z.object({ records: z.array(recordSchema) });
test.afterEach(async ({ context }) => {
  await settleWrites(context);
});
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
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const setup = page.getByRole("button", { name: "Set up my plan" });
  if (await setup.isVisible()) await setup.click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.getByRole("link", { name: "Edit repeating week" }).click();
  await page.getByLabel("Plan start date").fill("2026-01-05");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.locator("#view-date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
});
test("plan preview is read-only and browser back returns to Today", async ({
  page,
}, info) => {
  await mkdir("private/screenshots", { recursive: true });
  await page.getByRole("heading", { level: 1, name: "Your week" }).click();
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
  await expect(page).toHaveURL(/\/plan\?date=2026-01-05&routineId=/);
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".plan-exercise")).toHaveCount(6);
  await expect(page.getByRole("timer")).toHaveCount(0);
  await expect(
    page.locator(".plan-exercise").filter({ hasText: "Supported one-arm row" }),
  ).toContainText("2 × 10–15 reps each side");
  await expect(
    page.locator(".plan-exercise").filter({ hasText: "Forearm plank" }),
  ).toContainText("2 × 20–40 seconds");
  await expect(
    page.getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Workout plan · Fitness · bent.build");
  await expect(page.locator("h1")).toBeFocused();
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
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page.goto(
    "/plan?date=2026-01-08&routineId=00000000-0000-4000-8000-0000000000ff",
  );
  await expect(
    page.getByRole("heading", { name: "Plan unavailable" }),
  ).toBeVisible();
  const final = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  expect(final.records).toEqual(before.records);
});
test("main navigation returns to today and the date picker adds browser history entries", async ({
  page,
}) => {
  await expect(page).toHaveURL(/\/\?date=2026-01-05$/);
  await expect(page.locator(".date-banner")).toContainText(
    "Viewing Mon 5 Jan 2026",
  );
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/food$/);
  await expect(page.locator(".date-banner")).toHaveCount(0);
  await expect(
    page.getByRole("navigation").locator("[aria-current=page]"),
  ).toHaveText("Food");
  await expect(page).toHaveTitle("Food · Fitness · bent.build");
  await expect(page.locator("h1")).toBeFocused();
  const today = await page.locator("#view-date").inputValue();
  await page.reload();
  await expect(page.getByLabel("Meal or snack")).toBeVisible();
  await page.locator("#view-date").fill("2026-01-06");
  await expect(page).toHaveURL(/date=2026-01-06/);
  await expect(page).toHaveURL(/\/food\?date=2026-01-06/);
  await expect(page.locator(".date-banner")).toContainText(
    "Viewing Tue 6 Jan 2026",
  );
  await expect(
    page.getByRole("heading", { name: "Logged on Tue 6 Jan 2026" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/food$/);
  await expect(page.locator("#view-date")).toHaveValue(today);
  await page.goBack();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  await expect(page.locator("#view-date")).toHaveValue("2026-01-05");
  await page.goForward();
  await page.goForward();
  await expect(page.getByLabel("Meal or snack")).toBeVisible();
  await expect(page.locator("#view-date")).toHaveValue("2026-01-06");
  await page
    .getByRole("link", { name: "Return to today", exact: true })
    .click();
  await expect(page).toHaveURL(/\/food$/);
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await page.getByRole("link", { name: "Exercises", exact: true }).click();
  await expect(page).toHaveURL(/\/guides/);
  await expect(page.locator("#view-date")).toHaveCount(0);
  await expect(
    page.getByRole("navigation").locator("[aria-current=page]"),
  ).toHaveText("Exercises");
  await page.goBack();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  await page.locator(".wordmark").click();
  await expect(page).toHaveURL(/\/$/);
});
test("starting a workout runs elapsed time and preserves timers and draft across navigation", async ({
  page,
}, info) => {
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  const url = page.url();
  const planPath =
    "/plan?date=2026-01-05&routineId=00000000-0000-4000-8000-00000000000a";
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
  await page.getByText("Rest controls", { exact: true }).click();
  await page
    .getByRole("button", { name: "Start new 2:00 rest", exact: true })
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
  for (const set of [1, 2])
    await page
      .getByRole("button", {
        name: `Dumbbell Romanian deadlift set ${set} complete`,
        exact: true,
      })
      .click();
  await expect(rest.locator("strong")).toHaveText(/^(2:00|1:\d{2})$/);
  if (!(await page.getByLabel("New rest length", { exact: true }).isVisible()))
    await page.getByText("Rest controls", { exact: true }).click();
  await page.getByLabel("New rest length", { exact: true }).selectOption("75");
  await page
    .getByRole("button", { name: "Start new 1:15 rest", exact: true })
    .click();
  await expect(rest.locator("strong")).toHaveText(/^1:(1[0-5]|0\d)$/);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.reload();
  await expect(rest.locator("strong")).toHaveText(/^1:\d{2}$/);
  await expect(page.getByRole("button", { name: /Restart/ })).toHaveCount(0);
  const before = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  // While a workout is active, Today shows only the resume card.
  await expect(
    page.getByRole("link", { name: "View workout plan", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Mon 5 Jan 2026: Strength A, Not recorded" })
    .click();
  await expect(
    page.getByRole("link", { name: "View workout plan", exact: true }),
  ).toHaveCount(0);
  await page.goto(planPath);
  await expect(
    page.getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    }),
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
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page).toHaveURL(url);
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Workout unavailable" }),
  ).toHaveCount(0);
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
    .getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  const workoutUrl = page.url();
  const sets = page.getByRole("button", { name: / set \d+ complete$/ });
  await expect(sets).toHaveCount(12);
  const count = await sets.count();
  for (let index = 0; index < count; index++) await sets.first().click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-05/);
  await expect(page.locator(".sync-state")).toHaveText("Saved", {
    timeout: 20000,
  });
  await expect(
    page.locator("details[open] summary", { hasText: "Mon 5 Jan 2026" }),
  ).toContainText("Strength A");
  await page.goBack();
  await expect(page).toHaveURL(/\/plan\?date=2026-01-05/);
  await expect(page.locator(".plan-summary")).toContainText(
    "You recorded Strength A for Mon 5 Jan 2026.",
  );
  await page.goto(workoutUrl);
  await expect(
    page.getByRole("heading", { name: "Workout completed", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Workout completed", exact: true }),
  ).toBeVisible();
});

test("introductory plan matches a custom one-set workout", async ({ page }) => {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: /Repeating week and routines/ }).click();
  await page.locator(".routine-editor > summary").first().click();
  await page.getByLabel("Sets", { exact: true }).first().fill("1");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.locator("#view-date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await expect(page.locator(".plan-exercise").first()).toContainText(
    "1 × 8–12 reps",
  );
  await expect(page.locator(".subtitle")).toContainText("up to 2 sets each");
  await page
    .getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Goblet squat set 1 complete",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Goblet squat set 2 complete",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator(".set-count")).toContainText("0/11 sets");
});

test("toolbar configure, navigation and selection redact private activity URL parameters", async ({
  page,
}) => {
  const privateRoutine = "Synthetic private teaching plan";
  await page.getByRole("link", { name: "Edit repeating week" }).click();
  await page.locator(".routine-editor > summary").first().click();
  await page
    .getByLabel("Routine name", { exact: true })
    .first()
    .fill(privateRoutine);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.locator("#view-date").fill("2026-01-05");
  await page.route("https://toolbar.bent.build/toolbar?**", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<pre id="messages">[]</pre><script>const messages=[];addEventListener('message',event=>{messages.push(event.data);document.querySelector('#messages').textContent=JSON.stringify(messages)});parent.postMessage({type:'feedback:ready'},'http://localhost:3025');</script>`,
    }),
  );
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  const plan = new URL(page.url());
  const routineId = plan.searchParams.get("routineId");
  if (!routineId) throw Error("Missing synthetic routine ID");
  await page.reload();
  const panel = page
    .frames()
    .find((frame) =>
      frame.url().startsWith("https://toolbar.bent.build/toolbar?"),
    );
  if (!panel) throw Error("Toolbar panel did not load");
  const payloads = panel.locator("#messages");
  await expect(payloads).toContainText("feedback:configure");
  await expect(payloads).toContainText('"url":"http://localhost:3025/plan"');
  await panel.evaluate(() =>
    window.parent.postMessage(
      { type: "feedback:select" },
      "http://localhost:3025",
    ),
  );
  await expect(page.locator("html")).toHaveCSS("cursor", "crosshair");
  await page.locator(".plan-preview").dispatchEvent("click");
  await expect(payloads).toContainText("feedback:selected");
  await page
    .getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  const workoutId = new URL(page.url()).searchParams.get("workoutId");
  if (!workoutId) throw Error("Missing synthetic workout ID");
  await expect(payloads).toContainText("feedback:navigation");
  await expect(payloads).toContainText('"url":"http://localhost:3025/workout"');
  for (const secret of ["2026-01-05", routineId, workoutId])
    await expect(payloads).not.toContainText(secret);
  await panel.evaluate(() =>
    window.parent.postMessage(
      { type: "feedback:select" },
      "http://localhost:3025",
    ),
  );
  await expect(page.locator("html")).toHaveCSS("cursor", "crosshair");
  await page.locator(".content > section").dispatchEvent("click");
  await expect(payloads).toContainText("[Private element]");
  for (const secret of ["2026-01-05", routineId, workoutId])
    await expect(payloads).not.toContainText(secret);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Exercises", exact: true })
    .click();
  for (const target of [".exercise-tile .tile-text small", ".content"]) {
    await panel.evaluate(() =>
      window.parent.postMessage(
        { type: "feedback:select" },
        "http://localhost:3025",
      ),
    );
    await expect(page.locator("html")).toHaveCSS("cursor", "crosshair");
    await page.locator(target).first().dispatchEvent("click");
    await expect(payloads).not.toContainText(privateRoutine);
  }
  await page
    .locator(".exercise-tile")
    .filter({ hasText: "Goblet squat" })
    .click();
  await expect(page).toHaveURL(/guides\?exercise=squat/);
  for (const target of [".exercise-detail .fact-list", ".content"]) {
    await panel.evaluate(() =>
      window.parent.postMessage(
        { type: "feedback:select" },
        "http://localhost:3025",
      ),
    );
    await expect(page.locator("html")).toHaveCSS("cursor", "crosshair");
    await page.locator(target).dispatchEvent("click");
    await expect(payloads).not.toContainText(privateRoutine);
  }
});

async function openBodyweight(page: Page) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Progress", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Progress sections" })
    .getByRole("link", { name: "Bodyweight", exact: true })
    .click();
}
async function records(page: Page) {
  return exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  ).records;
}
async function startPastWorkout(page: Page) {
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Log workout for Mon 5 Jan 2026",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  const workoutId = new URL(page.url()).searchParams.get("workoutId");
  if (!workoutId) throw Error("Missing synthetic workout ID");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  return workoutId;
}
async function ownerId(page: Page) {
  const owner = await page.evaluate(() => {
    const value: unknown = Reflect.get(window, "Clerk");
    const user: unknown =
      value && typeof value === "object" ? Reflect.get(value, "user") : null;
    const id: unknown =
      user && typeof user === "object" ? Reflect.get(user, "id") : null;
    return typeof id === "string" ? id : "";
  });
  expect(owner).not.toBe("");
  return owner;
}
async function keepTypedValues(page: Page, key: string, values: object) {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key,
    value: JSON.stringify(values),
  });
}
/** Runs a query against the synthetic development database. */
async function withDatabase<T>(
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw Error("Dedicated development configuration is required");
  const sql = postgres(url, { ssl: "verify-full", max: 1, prepare: false });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}
async function openSecondTab(page: Page, path: string) {
  const other = await page.context().newPage();
  other.setDefaultTimeout(10000);
  await setupClerkTestingToken({ page: other });
  await other.goto(path);
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  return other;
}
async function setUnits(page: Page, units: "Kilograms" | "Pounds") {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Display units").selectOption({ label: units });
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.goto("/?date=2026-01-05");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
}
async function workoutData(page: Page, id: string) {
  const record = (await records(page)).find((item) => item.id === id);
  if (record?.data.kind !== "workout") throw Error("Missing workout");
  return record.data;
}

test("week days link to each day, and future plans start today", async ({
  page,
}) => {
  const week = page.getByRole("navigation", { name: "Training week" });
  await expect(week.getByRole("link")).toHaveCount(9);
  await expect(
    week.getByRole("link", {
      name: "Wed 7 Jan 2026: Strength B, Not recorded",
    }),
  ).toBeVisible();
  await week.getByRole("link", { name: "Next week" }).click();
  await expect(page).toHaveURL(/\/\?date=2026-01-12/);
  await page.goBack();
  await week
    .getByRole("link", { name: "Wed 7 Jan 2026: Strength B, Not recorded" })
    .click();
  await expect(page).toHaveURL(/\/\?date=2026-01-07$/);
  await expect(
    week.getByRole("link", {
      name: "Wed 7 Jan 2026: Strength B, Not recorded",
    }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plan\?date=2026-01-07&routineId=/);
  await expect(
    page.getByRole("heading", { name: "Strength B", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Do this workout today", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await week
    .getByRole("link", { name: "Tue 6 Jan 2026: Easy run, Not recorded" })
    .click();
  await page.getByRole("link", { name: "Record run", exact: true }).click();
  await expect(page).toHaveURL(/\/run\?date=2026-01-06/);
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue(
    "2026-01-06",
  );
  await page.goto("/plan?date=2026-01-05");
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page.goto("/run");
  await expect(
    page.getByRole("heading", { name: "Easy run", exact: true }),
  ).toBeVisible();
  // A future plan becomes today's workout and does not move the date.
  await page.goto("/?date=2030-01-07");
  await expect(page.locator(".date-banner")).toContainText("Mon 7 Jan 2030");
  await week
    .getByRole("link", { name: /^Wed 9 Jan 2030: Strength [AB], Planned$/ })
    .click();
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Do this workout today", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workout\?workoutId=[^&]+$/);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const workoutId = new URL(page.url()).searchParams.get("workoutId") ?? "";
  const settings = (await records(page)).find(
    (record) => record.data.kind === "settings",
  )?.data;
  if (settings?.kind !== "settings") throw Error("Missing settings");
  expect((await workoutData(page, workoutId)).date).toBe(
    localDate(settings.timezone),
  );
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/food$/);
  await expect(page.locator(".date-banner")).toHaveCount(0);
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Resume workout", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View workout plan", exact: true }),
  ).toHaveCount(0);
});

test("typed set values save when leaving the set, invalid text stays, sets can be skipped and rest end is announced", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "vibrate", {
      value: (pattern: number[]) => {
        document.documentElement.dataset.vibrated = JSON.stringify(pattern);
        return true;
      },
    });
  });
  await page.clock.install();
  await page.reload();
  const workoutId = await startPastWorkout(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/_serverFn/"))
      writes.push(request.url());
  });
  const status = page.locator(".sync-state");
  const reps = page.getByRole("spinbutton", {
    name: "Goblet squat set 1 reps",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Goblet squat set 1 complete", exact: true })
    .click();
  await expect(status).toHaveText("Saved");
  writes.length = 0;
  // Correcting a completed set keeps exactly what was typed.
  await reps.fill("");
  await page.locator("h1").click();
  await expect(reps).toHaveValue("");
  await expect(reps).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter reps as a number of 0 or more.", { exact: true }),
  ).toBeVisible();
  await expect(status).toHaveText("Unsaved input on device");
  await reps.pressSequentially("9");
  await page
    .getByRole("spinbutton", { name: "Goblet squat set 1 weight", exact: true })
    .fill("6.5");
  expect(writes).toHaveLength(0);
  await page.locator("h1").click();
  await expect(status).toHaveText("Saved");
  expect(writes).toHaveLength(1);
  await expect(reps).toHaveValue("9");
  const saved = await workoutData(page, workoutId);
  expect(saved.exercises[0]?.sets[0]).toMatchObject({
    value: 9,
    loadKg: 6.5,
    done: true,
  });
  // The pinned timer bar stays compact.
  const bar = await page.locator(".workout-timing").boundingBox();
  expect(bar?.height ?? 999).toBeLessThan(110);
  // Skip a set: finishing needs every set done or skipped.
  await page
    .getByRole("button", { name: "Goblet squat set 2 skip", exact: true })
    .click();
  await expect(page.locator(".set-count")).toContainText("1 skipped");
  const finish = page.getByRole("button", {
    name: "Finish workout",
    exact: true,
  });
  await expect(finish).toBeDisabled();
  // Rest end is shown, announced and vibrates.
  await page.getByText("Rest controls", { exact: true }).click();
  await page.getByLabel("New rest length", { exact: true }).selectOption("30");
  await page
    .getByRole("button", { name: "Start new 0:30 rest", exact: true })
    .click();
  const rest = page.getByRole("timer", { name: "Rest timer", exact: true });
  await expect(rest).toContainText(/0:(29|30)/);
  await page.clock.fastForward("00:32");
  await expect(rest).toContainText("Rest done");
  await expect(page.locator(".rest-announcement")).toHaveText(
    "Rest done. Next: Flat dumbbell bench press, set 1.",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-vibrated",
    "[200,100,200]",
  );
  await page.screenshot({
    path: `private/screenshots/workout-rest-done-${info.project.name}.png`,
  });
  const remaining = page
    .locator(".set:not(.is-skipped)")
    .getByRole("button", { name: / set \d+ complete$/ });
  while ((await remaining.count()) > 0) await remaining.first().click();
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-05/);
  await expect(status).toHaveText("Saved", { timeout: 20000 });
  await expect(page.locator("details[open]")).toContainText(
    "6.5 kg × 9 reps · Skipped",
  );
  const finished = await workoutData(page, workoutId);
  expect(finished.finishedAt).not.toBeNull();
  expect(finished.exercises[0]?.sets[1]).toMatchObject({
    skipped: true,
    done: false,
  });
});

test("typed values recovered on this device save automatically unless they changed elsewhere", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  // Simulate a closed tab that kept typed values without saving them.
  await keepTypedValues(page, `bent:fitness:inputs:v2:${owner}:${workoutId}`, {
    "0:0:value": { text: "11", base: "8", units: "kg" },
    "0:1:value": { text: "12", base: "5", units: "kg" },
    notes: { text: "Recovered note", base: "", units: "kg" },
  });
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await expect(
    page.getByText("A highlighted value changed on another device.", {
      exact: false,
    }),
  ).toBeVisible();
  const held = page.getByRole("spinbutton", {
    name: "Goblet squat set 2 reps",
    exact: true,
  });
  await expect(held).toHaveValue("12");
  await expect(held).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".sync-state")).toHaveText(
    "Unsaved input on device",
  );
  await expect
    .poll(async () => (await workoutData(page, workoutId)).notes)
    .toBe("Recovered note");
  const recovered = await workoutData(page, workoutId);
  expect(recovered.exercises[0]?.sets[0]?.value).toBe(11);
  expect(recovered.exercises[0]?.sets[1]?.value).toBe(8);
  // Leaving the held field saves the typed value on purpose.
  await held.focus();
  await page.locator("h1").click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[1]?.value,
  ).toBe(12);
});

test("history corrects, removes and restores workouts without changing the original, and edits runs", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const sets = page.getByRole("button", { name: / set \d+ complete$/ });
  while ((await sets.count()) > 0) await sets.first().click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved", {
    timeout: 20000,
  });
  const original = await workoutData(page, workoutId);
  const label = "Strength A on Mon 5 Jan 2026";
  await page.getByRole("button", { name: `Correct ${label}` }).click();
  await expect(
    page.getByRole("heading", { name: "Correct Strength A" }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Goblet squat set 1 weight", exact: true })
    .fill("4");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByText("Enter a short reason for the correction."),
  ).toBeVisible();
  await page
    .getByLabel("Reason for correction")
    .fill("Entered the wrong weight");
  // Leaving with unsaved correction changes asks first.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(page).toHaveURL(/\/history/);
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const entry = page.locator("details", { hasText: label.split(" on ")[0] });
  await expect(page.locator("details[open] summary")).toContainText(
    "Corrected",
  );
  await expect(page.locator("details[open]")).toContainText("4 kg × 8 reps");
  let all = await records(page);
  expect(all.find((record) => record.id === workoutId)?.data).toEqual(original);
  expect(
    all.filter((record) => record.data.kind === "workoutCorrection"),
  ).toHaveLength(1);
  // Restore the original.
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: `Restore original results for ${label}` })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await expect(entry.first()).not.toContainText("Corrected");
  // Remove, then restore from Removed workouts.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: `Remove ${label}` }).click();
  await expect(
    page.getByRole("heading", { name: "Removed workouts" }),
  ).toHaveCount(0);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Remove ${label}` }).click();
  await expect(
    page.getByRole("heading", { name: "Removed workouts" }),
  ).toBeVisible();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.goto("/?date=2026-01-05");
  await expect(
    page.getByRole("link", {
      name: "Mon 5 Jan 2026: Strength A, Not recorded",
    }),
  ).toBeVisible();
  await page.goto("/history");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Restore ${label}` }).click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  all = await records(page);
  expect(all.find((record) => record.id === workoutId)?.data).toEqual(original);
  expect(all.some((record) => record.data.kind === "workoutCorrection")).toBe(
    false,
  );
  await page.goto("/?date=2026-01-05");
  await page
    .getByRole("link", { name: "Mon 5 Jan 2026: Strength A, Done" })
    .click();
  await page.getByRole("link", { name: "View results", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-05/);
  // Runs can be edited and removed.
  await page.goto("/run?date=2026-01-06");
  await page.getByLabel("Duration · minutes").fill("25");
  await page.getByLabel("Distance · km").fill("4");
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-06/);
  const run = "Easy run on Tue 6 Jan 2026";
  await page.getByRole("link", { name: `Edit ${run}` }).click();
  await page.getByLabel("Duration · minutes").fill("30");
  await page.getByRole("button", { name: "Save run changes" }).click();
  await expect(page.getByText("30 min · 4 km")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Remove ${run}` }).click();
  await expect(page.getByText("30 min · 4 km")).toHaveCount(0);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect((await records(page)).some((r) => r.data.kind === "run")).toBe(false);
});

test("settings confirm saves, explain errors, warn before losing edits and export completely", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveTitle("Settings · Fitness · bent.build");
  await expect(
    page.getByRole("link", { name: /Repeating week and routines/ }),
  ).toBeVisible();
  const goal = page.getByLabel("Goal", { exact: true });
  await goal.fill("Synthetic stronger goal");
  const save = page.getByRole("button", { name: "Save settings", exact: true });
  await save.click();
  await expect(page.locator(".save-settings [role=status]")).toHaveText(
    "Settings saved.",
  );
  await expect(save).toBeFocused();
  await page.getByLabel(/Dumbbell sizes/).fill("5, abc");
  await save.click();
  await expect(page.locator("#dumbbell-error")).toContainText(
    "Enter dumbbell sizes as positive numbers separated by commas",
  );
  await expect(page.locator(".settings-error")).toBeFocused();
  await page.getByRole("button", { name: "Go to this setting" }).click();
  await expect(page.getByLabel(/Dumbbell sizes/)).toBeFocused();
  await page.getByLabel(/Dumbbell sizes/).fill("5, 7.5");
  // Unsaved changes ask before leaving.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByLabel(/Dumbbell sizes/)).toHaveValue("5, 7.5");
  await save.click();
  await expect(page.locator(".save-settings [role=status]")).toHaveText(
    "Settings saved.",
  );
  await page.getByRole("link", { name: /Repeating week and routines/ }).click();
  await expect(page).toHaveTitle("Repeating week · Fitness · bent.build");
  await expect(page.getByText(/Strength days take turns/)).toBeVisible();
  await page.locator(".routine-editor > summary").first().click();
  const routine = page.locator(".routine-editor").first();
  await expect(
    routine.getByRole("option", {
      name: /Goblet squat · already in this routine/,
    }),
  ).toBeDisabled();
  await routine
    .getByRole("button", { name: "Move Flat dumbbell bench press up" })
    .click();
  await expect(routine.locator("legend").first()).toHaveText(
    "1. Flat dumbbell bench press",
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(page).toHaveURL(/\/food/);
  // A failed export does not save a partial file.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.route("**/api/export", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"records":[' }),
  );
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page
    .getByRole("button", { name: "Export account data and photos" })
    .click();
  await expect(page.locator(".settings-error")).toContainText(
    "Export did not finish. No file was saved.",
  );
  expect(downloaded).toBe(false);
  await page.unroute("**/api/export");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export account data and photos" })
    .click();
  expect((await download).suggestedFilename()).toBe("fitness-export.json");
});

test("food entries can be edited and removed, and the body chart labels recorded values", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Food" }),
  ).toBeVisible();
  await page.locator("#view-date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await expect(
    page.getByText("No food recorded for this date.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Meal or snack").fill("Synthetic oats");
  await page.getByLabel("Calories · kcal").fill("350.5");
  await page.getByLabel("Protein · g", { exact: true }).fill("12");
  await page.getByLabel("Save as a regular meal").check();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(
    page.getByText("Added Synthetic oats for Mon 5 Jan 2026."),
  ).toBeVisible();
  await expect(page.locator(".list-row")).toContainText(
    "351 kcal · 12g protein",
  );
  // Hovering a day of the seven-day chart shows its totals, and each day's
  // link describes them for screen readers.
  await expect(
    page.getByRole("link", { name: "Mon 5 Jan 2026: 351 kcal" }),
  ).toHaveAccessibleDescription(
    /^Mon 5 Jan 2026: Calories 351 kcal, Target \d+ kcal, (Left|Over) \d+ kcal, Protein 12 g\.$/,
  );
  // The totals show below the days, for the day shown until another is
  // hovered or focused, so they never cover a day.
  const dayCard = page.locator(".food-side .chart-card");
  await expect(dayCard).toContainText("Mon 5 Jan 2026");
  await expect(dayCard).toContainText("351 kcal");
  await expect(dayCard).toContainText("12 g");
  const firstDay = page.locator(".day-strip li").first();
  await firstDay.hover();
  await expect(dayCard).toContainText("Tue 30 Dec 2025");
  const strip = await page.locator(".day-strip").boundingBox();
  const card = await dayCard.boundingBox();
  expect(card && strip && card.y >= strip.y + strip.height).toBe(true);
  // The totals stay while the pointer moves onto them; Escape returns to the
  // day shown, and so does moving the pointer off the days.
  await dayCard.hover();
  await expect(dayCard).toContainText("Tue 30 Dec 2025");
  await page.keyboard.press("Escape");
  await expect(dayCard).toContainText("Mon 5 Jan 2026");
  await firstDay.hover();
  await expect(dayCard).toContainText("Tue 30 Dec 2025");
  await page.getByLabel("Meal or snack").hover();
  await expect(dayCard).toContainText("Mon 5 Jan 2026");
  await page.getByLabel("Meal or snack").fill("synthetic oats");
  await page.getByLabel("Calories · kcal").fill("350.5");
  await page.getByLabel("Protein · g", { exact: true }).fill("12");
  await page.getByLabel("Save as a regular meal").check();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(
    page.getByText("It is already in Regular meals.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^Add saved meal \d+: Synthetic oats to /,
    }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Edit synthetic oats", exact: true })
    .click();
  await expect(page.getByLabel("Meal or snack")).toBeFocused();
  await page.getByLabel("Calories · kcal").fill("300");
  await page.getByRole("button", { name: "Save food changes" }).click();
  await expect(
    page.locator(".list-row", { hasText: /synthetic oats/ }),
  ).toContainText("300 kcal");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page
    .getByRole("button", { name: "Remove synthetic oats", exact: true })
    .click();
  await expect(
    page.locator(".list-row", { hasText: /synthetic oats/ }),
  ).toHaveCount(1);
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Remove synthetic oats", exact: true })
    .click();
  await expect(
    page.locator(".list-row", { hasText: /synthetic oats/ }),
  ).toHaveCount(0);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await openBodyweight(page);
  for (const [date, kg] of [
    ["2026-01-05", "70.25"],
    ["2026-01-06", "71.2"],
  ]) {
    await page.locator("#weight-date").fill(date);
    await page.getByLabel("Weight · kg", { exact: true }).fill(kg);
    await page.getByRole("button", { name: "Save weigh-in" }).click();
    await expect(page.locator(".sync-state")).toHaveText("Saved");
  }
  await expect(page.locator(".big-number")).toHaveText("70.7 kg");
  const chart = page.locator(".weight-chart");
  await expect(chart).toContainText("High 71.2 kg");
  await expect(chart).toContainText("Low 70.3 kg");
  await expect(chart).toContainText("Mon 5 Jan");
  await expect(chart).toContainText("Tue 6 Jan");
  // Hovering shows the nearest weigh-in, and Escape hides it with focus
  // elsewhere.
  const weightCard = page.locator(".chart-frame .chart-card");
  await chart.hover({ position: { x: 2, y: 100 } });
  await expect(weightCard).toContainText("Mon 5 Jan 2026");
  await expect(weightCard).toContainText("70.3 kg");
  await expect(weightCard).toContainText("Average of 1");
  await page.keyboard.press("Escape");
  await expect(weightCard).toHaveCount(0);
  // The chart's slider moves between weigh-ins and reads each one.
  const weighIns = page.getByRole("slider", { name: "Weigh-ins" });
  await expect(weighIns).toHaveAttribute("aria-valuetext", "No point selected");
  await weighIns.focus();
  await page.keyboard.press("End");
  await expect(weightCard).toContainText("Tue 6 Jan 2026");
  await expect(weightCard).toContainText("Average of 2");
  await expect(weightCard).toContainText("70.7 kg");
  await expect(weightCard).toContainText("Since Mon 5 Jan");
  await expect(weightCard).toContainText("+1.0 kg");
  await expect(weighIns).toHaveAttribute(
    "aria-valuetext",
    "Tue 6 Jan 2026: Weigh-in 71.2 kg, Average of 2 70.7 kg, Since Mon 5 Jan +1.0 kg.",
  );
  await expect(weighIns).toHaveAttribute("aria-valuenow", "2");
  await page.keyboard.press("Home");
  await expect(weightCard).toContainText("Mon 5 Jan 2026");
  await page.keyboard.press("Escape");
  await expect(weightCard).toHaveCount(0);
  await page.getByText("All weigh-ins", { exact: true }).click();
  await expect(
    page.locator(".list-row").getByText("70.25 kg", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Remove weigh-in Tue 6 Jan 2026" })
    .click();
  await expect(chart).not.toContainText("High 71.2 kg");
});

test("recovered weights keep the units they were typed in when units change elsewhere", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  const key = `bent:fitness:inputs:v2:${owner}:${workoutId}`;
  const first = page.getByRole("spinbutton", {
    name: "Goblet squat set 1 weight",
    exact: true,
  });
  const second = page.getByRole("spinbutton", {
    name: "Goblet squat set 2 weight",
    exact: true,
  });
  // Both sets start from a saved weight of zero.
  await first.fill("0");
  await second.fill("0");
  await page.locator("h1").click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const zero = await workoutData(page, workoutId);
  expect(zero.exercises[0]?.sets[0]?.loadKg).toBe(0);
  expect(zero.exercises[0]?.sets[1]?.loadKg).toBe(0);
  // 10 kg was typed before the tab closed. The units then change to lb.
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  await keepTypedValues(page, key, {
    "0:0:loadKg": { text: "10", base: "0", units: "kg" },
  });
  await setUnits(page, "Pounds");
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await workoutData(page, workoutId)).exercises[0]?.sets[0]?.loadKg,
    )
    .toBe(10);
  await expect(first).toHaveValue("22.05");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  // 22 lb was typed before the tab closed. The units then change to kg.
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  await keepTypedValues(page, key, {
    "0:1:loadKg": { text: "22", base: "0", units: "lb" },
  });
  await setUnits(page, "Kilograms");
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await workoutData(page, workoutId)).exercises[0]?.sets[1]?.loadKg,
    )
    .toBeCloseTo(9.979, 3);
  await expect(second).toHaveValue("9.98");
  await expect(first).toHaveValue("10");
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  // Values kept without units save other fields and hold the weight.
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  const before = await workoutData(page, workoutId);
  const legacy = `bent:fitness:inputs:v1:${owner}:${workoutId}`;
  await keepTypedValues(page, legacy, {
    "0:0:value": {
      text: "7",
      base: String(before.exercises[0]?.sets[0]?.value),
    },
    "0:1:loadKg": { text: "12", base: "9.98" },
  });
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await expect(
    page.getByText("Confirm it is in kg, then leave the set to save it.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(second).toHaveValue("12");
  await expect(second).toHaveAttribute("aria-invalid", "true");
  await expect
    .poll(
      async () =>
        (await workoutData(page, workoutId)).exercises[0]?.sets[0]?.value,
    )
    .toBe(7);
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[1]?.loadKg,
  ).toBeCloseTo(9.979, 3);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), legacy),
  ).toBeNull();
  expect(await storedTypedValues(page, key)).toEqual({
    "0:1:loadKg": { text: "12", base: null, units: null },
  });
  // Leaving the set confirms the weight in the units shown beside it.
  await second.focus();
  await page.locator("h1").click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[1]?.loadKg,
  ).toBe(12);
});

test("sections open offline on their first visit and typed workout values save after reconnecting", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const status = page.locator(".sync-state");
  // A value kept only in this page shows the app was not reloaded.
  await page.evaluate(() => Reflect.set(window, "fitnessVisit", "open"));
  const weight = page.getByRole("spinbutton", {
    name: "Goblet squat set 1 weight",
    exact: true,
  });
  await weight.fill("9");
  await expect(status).toHaveText("Unsaved input on device");
  await page.context().setOffline(true);
  await expect(status).toHaveText("Offline · pending on device");
  // The longest save status fits without widening the page.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  const sections = [
    { nav: "Main navigation", name: "Progress", heading: "Progress" },
    { nav: "Progress sections", name: "Sessions", heading: "History" },
    { nav: "Progress sections", name: "Bodyweight", heading: "Bodyweight" },
    { nav: "Main navigation", name: "Exercises", heading: "Exercises" },
    { nav: "Main navigation", name: "Food", heading: "Food" },
    { nav: "Main navigation", name: "Week", heading: "Your week" },
  ];
  for (const { nav, name, heading } of sections) {
    await page
      .getByRole("navigation", { name: nav })
      .getByRole("link", { name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: heading, exact: true }),
    ).toBeVisible();
  }
  expect(await page.evaluate(() => Reflect.get(window, "fitnessVisit"))).toBe(
    "open",
  );
  for (let step = 0; step < sections.length; step++) await page.goBack();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  await expect(weight).toHaveValue("9");
  expect(await page.evaluate(() => Reflect.get(window, "fitnessVisit"))).toBe(
    "open",
  );
  await page.context().setOffline(false);
  await expect(status).toHaveText("Saved");
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[0]?.loadKg,
  ).toBe(9);
});

test("food edits keep typed changes when another tab changes or removes the entry", async ({
  page,
}) => {
  const status = page.locator(".sync-state");
  await page.goto("/food?date=2026-01-05");
  await page.getByLabel("Meal or snack").fill("Synthetic breakfast");
  await page.getByLabel("Calories · kcal").fill("550");
  await page.getByLabel("Protein · g", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(status).toHaveText("Saved");
  const meals = async () =>
    (await records(page)).flatMap((record) =>
      record.data.kind === "meal" ? [{ ...record.data, id: record.id }] : [],
    );
  const originalId = (await meals())[0]?.id;
  if (!originalId) throw Error("Missing synthetic meal");
  const other = await openSecondTab(page, "/food?date=2026-01-05");
  // This tab changes only the name.
  await page
    .getByRole("button", { name: "Edit Synthetic breakfast", exact: true })
    .click();
  await page.getByLabel("Meal or snack").fill("Local breakfast edit");
  // The other tab changes the calories.
  await other
    .getByRole("button", { name: "Edit Synthetic breakfast", exact: true })
    .click();
  await other.getByLabel("Calories · kcal").fill("777");
  await other.getByRole("button", { name: "Save food changes" }).click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  const conflict = page.locator(".edit-conflict");
  await expect(conflict).toContainText("changed on another device");
  await expect(conflict).toContainText(
    "Synthetic breakfast · 777 kcal · 30g protein",
  );
  await expect(page.getByLabel("Meal or snack")).toHaveValue(
    "Local breakfast edit",
  );
  await expect(page.getByLabel("Calories · kcal")).toHaveValue("550");
  await expect(
    page.getByRole("button", { name: "Save food changes" }),
  ).toBeDisabled();
  expect((await meals())[0]).toMatchObject({
    name: "Synthetic breakfast",
    calories: 777,
  });
  // Loading the saved version replaces the typed values.
  await page.getByRole("button", { name: "Load saved version" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(page.getByLabel("Meal or snack")).toHaveValue(
    "Synthetic breakfast",
  );
  await expect(page.getByLabel("Calories · kcal")).toHaveValue("777");
  // Keeping typed changes over a newer version is a deliberate choice.
  await page.getByLabel("Meal or snack").fill("Local breakfast edit");
  await other
    .getByRole("button", { name: "Edit Synthetic breakfast", exact: true })
    .click();
  await other.getByLabel("Protein · g", { exact: true }).fill("31");
  await other.getByRole("button", { name: "Save food changes" }).click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  await expect(conflict).toContainText("777 kcal · 31g protein");
  await page.getByRole("button", { name: "Save my changes instead" }).click();
  await expect(
    page.getByText("Updated Local breakfast edit for Mon 5 Jan 2026."),
  ).toBeVisible();
  await expect(status).toHaveText("Saved");
  expect(await meals()).toEqual([
    expect.objectContaining({
      id: originalId,
      name: "Local breakfast edit",
      calories: 777,
      protein: 30,
    }),
  ]);
  // A removed entry stays removed unless its changes are saved as new food.
  await page
    .getByRole("button", { name: "Edit Local breakfast edit", exact: true })
    .click();
  await page.getByLabel("Calories · kcal").fill("600");
  other.once("dialog", (dialog) => void dialog.accept());
  await other
    .getByRole("button", { name: "Remove Local breakfast edit", exact: true })
    .click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  await expect(conflict).toContainText("was removed on another device");
  await expect(page.getByLabel("Calories · kcal")).toHaveValue("600");
  await expect(
    page.getByRole("button", { name: "Save food changes" }),
  ).toBeDisabled();
  expect(await meals()).toEqual([]);
  await page
    .getByRole("button", { name: "Save my changes as a new food" })
    .click();
  await expect(
    page.getByText("Added Local breakfast edit for Mon 5 Jan 2026."),
  ).toBeVisible();
  await expect(status).toHaveText("Saved");
  const saved = await meals();
  expect(saved).toEqual([
    expect.objectContaining({ name: "Local breakfast edit", calories: 600 }),
  ]);
  expect(saved[0]?.id).not.toBe(originalId);
  const [removed] = await withDatabase(
    (sql) => sql`SELECT deleted FROM fitness_records WHERE id=${originalId}`,
  );
  expect(removed?.deleted).toBe(true);
  await other.close();
});

test("loading the cloud version after a conflict keeps an open food edit from overwriting it", async ({
  page,
}) => {
  const status = page.locator(".sync-state");
  await page.goto("/food?date=2026-01-05");
  await page.getByLabel("Meal or snack").fill("Synthetic lunch");
  await page.getByLabel("Calories · kcal").fill("500");
  await page.getByLabel("Protein · g", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(status).toHaveText("Saved");
  const meal = (await records(page)).find((r) => r.data.kind === "meal");
  if (!meal) throw Error("Missing synthetic meal");
  // A change queued offline, then the entry is opened again.
  await page.context().setOffline(true);
  await expect(status).toHaveText("Offline · pending on device");
  const edit = page.getByRole("button", {
    name: "Edit Synthetic lunch",
    exact: true,
  });
  await edit.click();
  await page.getByLabel("Calories · kcal").fill("510");
  await page.getByRole("button", { name: "Save food changes" }).click();
  await expect(page.locator(".list-row")).toContainText("510 kcal");
  await edit.click();
  await page.getByLabel("Meal or snack").fill("Offline lunch");
  // Another device saves the same entry first.
  await withDatabase(
    (sql) =>
      sql`UPDATE fitness_records SET revision=revision+1, data=jsonb_set(data, '{calories}', '999'), updated_at=now() WHERE id=${meal.id}`,
  );
  await page.context().setOffline(false);
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use cloud version for this record" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toHaveCount(0);
  const conflict = page.locator(".edit-conflict");
  await expect(conflict).toContainText("Synthetic lunch · 999 kcal");
  await expect(page.getByLabel("Meal or snack")).toHaveValue("Offline lunch");
  await expect(
    page.getByRole("button", { name: "Save food changes" }),
  ).toBeDisabled();
  await expect(status).toHaveText("Saved");
  const stored = (await records(page)).find((r) => r.id === meal.id);
  expect(stored?.data).toMatchObject({
    name: "Synthetic lunch",
    calories: 999,
  });
});

test("run edits keep typed changes when another tab changes or removes the run", async ({
  page,
}) => {
  const status = page.locator(".sync-state");
  await page.goto("/run?date=2026-01-06");
  await page.getByLabel("Duration · minutes").fill("25");
  await page.getByLabel("Distance · km").fill("4");
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-06/);
  await expect(status).toHaveText("Saved");
  const label = "Easy run on Tue 6 Jan 2026";
  await page.getByRole("link", { name: `Edit ${label}` }).click();
  await expect(page).toHaveURL(/runId=/);
  const runId = new URL(page.url()).searchParams.get("runId");
  await page.getByLabel("Notes").fill("Local note");
  const other = await openSecondTab(
    page,
    new URL(page.url()).pathname + new URL(page.url()).search,
  );
  await other.getByLabel("Duration · minutes").fill("40");
  await other.getByRole("button", { name: "Save run changes" }).click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  const conflict = page.locator(".edit-conflict");
  await expect(conflict).toContainText("changed on another device");
  await expect(conflict).toContainText("Tue 6 Jan 2026 · 40 min · 4 km");
  await expect(page.getByLabel("Notes")).toHaveValue("Local note");
  await expect(page.getByLabel("Duration · minutes")).toHaveValue("25");
  await expect(
    page.getByRole("button", { name: "Save run changes" }),
  ).toBeDisabled();
  // The other tab removes the run.
  other.once("dialog", (dialog) => void dialog.accept());
  await other.getByRole("button", { name: `Remove ${label}` }).click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  await expect(conflict).toContainText("was removed on another device");
  await expect(page.getByLabel("Notes")).toHaveValue("Local note");
  expect((await records(page)).some((r) => r.data.kind === "run")).toBe(false);
  await page
    .getByRole("button", { name: "Save my changes as a new run" })
    .click();
  await expect(page).toHaveURL(/\/history\?date=2026-01-06/);
  await expect(status).toHaveText("Saved");
  const runs = (await records(page)).filter((r) => r.data.kind === "run");
  expect(runs).toHaveLength(1);
  expect(runs[0]?.id).not.toBe(runId);
  expect(runs[0]?.data).toMatchObject({ minutes: 25, notes: "Local note" });
  await other.close();
});

test("correction saves explain unhandled sets and keep typed changes when the cloud version wins", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const status = page.locator(".sync-state");
  const workoutId = await startPastWorkout(page);
  const sets = page.getByRole("button", { name: / set \d+ complete$/ });
  while ((await sets.count()) > 0) await sets.first().click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await expect(status).toHaveText("Saved", { timeout: 20000 });
  const original = await workoutData(page, workoutId);
  const label = "Strength A on Mon 5 Jan 2026";
  const corrections = async () =>
    (await records(page)).flatMap((record) =>
      record.data.kind === "workoutCorrection"
        ? [{ ...record, data: record.data }]
        : [],
    );
  // A set with neither Done nor Skip explains the fix instead of saving.
  await page.getByRole("button", { name: `Correct ${label}` }).click();
  await page
    .getByRole("button", { name: "Goblet squat set 1 completed", exact: true })
    .click();
  await page
    .getByLabel("Reason for correction")
    .fill("Entered the wrong weight");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Mark Goblet squat set 1 Done or Skip it before saving the correction.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Correct Strength A" }),
  ).toBeVisible();
  expect(await corrections()).toEqual([]);
  await page
    .getByRole("button", { name: "Goblet squat set 1 complete", exact: true })
    .click();
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByText(`Saved corrected results for ${label}.`),
  ).toBeVisible();
  await expect(status).toHaveText("Saved");
  const [first] = await corrections();
  if (!first) throw Error("Missing synthetic correction");
  expect(first.revision).toBe(1);
  // The correction is edited offline, then opened again.
  await page.context().setOffline(true);
  await expect(status).toHaveText("Offline · pending on device");
  await page.getByRole("button", { name: `Correct ${label}` }).click();
  const weight = (set: number) =>
    page.getByRole("spinbutton", {
      name: `Goblet squat set ${set} weight`,
      exact: true,
    });
  await weight(2).fill("5");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByText(`Saved corrected results for ${label}.`),
  ).toBeVisible();
  await page.getByRole("button", { name: `Correct ${label}` }).click();
  await expect(weight(2)).toHaveValue("5");
  await weight(1).fill("4.5");
  // Another device saves the same correction first.
  await withDatabase(
    (sql) =>
      sql`UPDATE fitness_records SET revision=revision+1, data=jsonb_set(data, '{reason}', '"Cloud reason"'), updated_at=now() WHERE id=${first.id}`,
  );
  await page.context().setOffline(false);
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use cloud version for this record" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toHaveCount(0);
  const conflict = page.locator(".edit-conflict");
  await expect(conflict).toContainText("changed on another device");
  await expect(conflict).toContainText("Mon 5 Jan 2026 · Cloud reason");
  await expect(weight(1)).toHaveValue("4.5");
  await expect(
    page.getByRole("button", { name: "Save correction" }),
  ).toBeDisabled();
  await expect(status).toHaveText("Saved");
  let [stored] = await corrections();
  expect(stored?.revision).toBe(2);
  expect(stored?.data.reason).toBe("Cloud reason");
  expect(stored?.data.replacement?.exercises[0]?.sets[1]?.loadKg).toBe(0);
  // Loading the saved version replaces the typed values, then saving keeps
  // the cloud fields that were not edited.
  await page.getByRole("button", { name: "Load saved version" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(weight(1)).toHaveValue("0");
  await expect(weight(2)).toHaveValue("0");
  await expect(page.getByLabel("Reason for correction")).toHaveValue(
    "Cloud reason",
  );
  await weight(1).fill("4.5");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByText(`Saved corrected results for ${label}.`),
  ).toBeVisible();
  await expect(status).toHaveText("Saved");
  [stored] = await corrections();
  expect(stored?.revision).toBe(3);
  expect(stored?.data.reason).toBe("Cloud reason");
  expect(stored?.data.replacement?.exercises[0]?.sets[0]?.loadKg).toBe(4.5);
  expect(stored?.data.replacement?.exercises[0]?.sets[1]?.loadKg).toBe(0);
  expect(await workoutData(page, workoutId)).toEqual(original);
  expect(failures).toEqual([]);
});

test("returning to invalid text after a cleanup failure never saves the abandoned number", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  const key = `bent:fitness:inputs:v2:${owner}:${workoutId}`;
  const before = await workoutData(page, workoutId);
  const reps = page.getByRole("spinbutton", {
    name: "Goblet squat set 1 reps",
    exact: true,
  });
  await reps.fill("");
  await page.evaluate((prefix) => {
    const original = Storage.prototype.removeItem;
    let failed = false;
    Storage.prototype.removeItem = function (key) {
      if (!failed && key.startsWith(`${prefix}:entry:`)) {
        failed = true;
        throw new DOMException("Storage is unavailable", "SecurityError");
      }
      return original.call(this, key);
    };
  }, key);
  await reps.fill("13");
  await expect(
    page.getByText("Typed values could not be kept on this device.", {
      exact: false,
    }),
  ).toBeVisible();
  // Return to the earlier invalid value without blurring or saving 13.
  await reps.fill("");
  await expect(
    page.getByText("Typed values could not be kept on this device.", {
      exact: false,
    }),
  ).toBeHidden();
  await page.reload();
  await expect(reps).toHaveValue("");
  await expect(reps).toHaveAttribute("aria-invalid", "true");
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[0]?.value,
  ).toBe(before.exercises[0]?.sets[0]?.value);
});

test("a partial migration failure cannot restore input after Skip", async ({
  page,
}, info) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  const key = `bent:fitness:inputs:v2:${owner}:${workoutId}`;
  const before = await workoutData(page, workoutId);
  await page.getByRole("link", { name: "Back to week", exact: true }).click();
  await keepTypedValues(page, key, {
    "0:0:value": {
      text: "",
      base: String(before.exercises[0]?.sets[0]?.value),
      units: "kg",
    },
    "0:1:value": {
      text: "",
      base: String(before.exercises[0]?.sets[1]?.value),
      units: "kg",
    },
  });
  await page.evaluate((prefix) => {
    const original = Storage.prototype.setItem;
    let appends = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(`${prefix}:entry:`) && ++appends === 2)
        throw new DOMException("Storage is full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  }, key);
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await page.getByLabel("Session notes").fill("Partial recovery");
  await expect(
    page.getByText("Typed values could not be kept on this device.", {
      exact: false,
    }),
  ).toBeVisible();
  for (const set of [1, 2])
    await page
      .getByRole("button", {
        name: `Goblet squat set ${set} skip`,
        exact: true,
      })
      .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect(await storedTypedValues(page, key)).toEqual({});
  await page.screenshot({
    path: `../../private/fitness-redesign/sol04-after-${info.project.name}.png`,
  });
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  for (const set of [1, 2]) {
    await expect(
      page.getByRole("spinbutton", {
        name: `Goblet squat set ${set} reps`,
        exact: true,
      }),
    ).not.toHaveValue("");
    await expect(
      page.getByRole("button", {
        name: `Goblet squat set ${set} skipped`,
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("overlapping tab writes retain both invalid fields after reload", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  const key = `bent:fitness:inputs:v2:${owner}:${workoutId}`;
  const path = new URL(page.url()).pathname + new URL(page.url()).search;
  const other = await openSecondTab(page, path);
  const reps = (tab: Page, set: number) =>
    tab.getByRole("spinbutton", {
      name: `Goblet squat set ${set} reps`,
      exact: true,
    });
  const debuggerSession = await page.context().newCDPSession(page);
  await debuggerSession.send("Debugger.enable");
  await page.evaluate((prefix) => {
    const original = Storage.prototype.setItem;
    function writeInput(storage: Storage, key: string, value: string) {
      return original.call(storage, key, value);
    }
    Reflect.set(window, "fitnessPauseWrite", writeInput);
    Storage.prototype.setItem = function (key, value) {
      return key.startsWith(prefix)
        ? writeInput(this, key, value)
        : original.call(this, key, value);
    };
  }, key);
  const target = await debuggerSession.send("Runtime.evaluate", {
    expression: "window.fitnessPauseWrite",
  });
  const objectId = z.string().parse(target.result.objectId);
  const breakpoint = await debuggerSession.send(
    "Debugger.setBreakpointOnFunctionCall",
    { objectId },
  );
  const paused = new Promise<void>((resolve) =>
    debuggerSession.once("Debugger.paused", () => resolve()),
  );
  // A stops immediately before its storage write, after any shared reads.
  const firstWrite = reps(page, 1).fill("");
  try {
    await paused;
    await reps(other, 2).fill("");
    await debuggerSession.send("Debugger.removeBreakpoint", {
      breakpointId: breakpoint.breakpointId,
    });
    await debuggerSession.send("Debugger.resume");
    await firstWrite;
  } finally {
    await debuggerSession.detach();
  }
  await other.close();
  await page.reload();
  await expect(reps(page, 1)).toHaveValue("");
  await expect(reps(page, 2)).toHaveValue("");
  await expect(reps(page, 1)).toHaveAttribute("aria-invalid", "true");
  await expect(reps(page, 2)).toHaveAttribute("aria-invalid", "true");
});

test("two tabs on one workout keep each other's typed values through reloads", async ({
  page,
}) => {
  const workoutId = await startPastWorkout(page);
  const owner = await ownerId(page);
  const key = `bent:fitness:inputs:v2:${owner}:${workoutId}`;
  const stored = () => storedTypedValues(page, key);
  const path = new URL(page.url()).pathname + new URL(page.url()).search;
  const other = await openSecondTab(page, path);
  const reps = (tab: Page, set: number) =>
    tab.getByRole("spinbutton", {
      name: `Goblet squat set ${set} reps`,
      exact: true,
    });
  // Tab A keeps invalid text in set 1.
  await reps(page, 1).fill("");
  await page.locator("h1").click();
  await expect(reps(page, 1)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".sync-state")).toHaveText(
    "Unsaved input on device",
  );
  // Tab B types in set 2. Both typed values stay on the device.
  await reps(other, 2).fill("11");
  expect(await stored()).toEqual({
    "0:0:value": expect.objectContaining({ text: "" }),
    "0:1:value": expect.objectContaining({ text: "11" }),
  });
  // Tab B saves its set. Tab A's value stays.
  await other.locator("h1").click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  expect(await stored()).toEqual({
    "0:0:value": expect.objectContaining({ text: "" }),
  });
  await other.close();
  // Another device then saves set 1.
  await withDatabase(
    (sql) =>
      sql`UPDATE fitness_records SET revision=revision+1, data=jsonb_set(data, '{exercises,0,sets,0,value}', '10'), updated_at=now() WHERE id=${workoutId}`,
  );
  await page.reload();
  await expect(reps(page, 1)).toHaveValue("");
  await expect(reps(page, 1)).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("A highlighted value changed on another device.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(reps(page, 2)).toHaveValue("11");
  let saved = await workoutData(page, workoutId);
  expect(saved.exercises[0]?.sets[0]?.value).toBe(10);
  expect(saved.exercises[0]?.sets[1]?.value).toBe(11);
  // Saving the held field is a deliberate choice.
  await reps(page, 1).fill("9");
  await page.locator("h1").click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  saved = await workoutData(page, workoutId);
  expect(saved.exercises[0]?.sets[0]?.value).toBe(9);
  expect(saved.exercises[0]?.sets[1]?.value).toBe(11);
  expect(await stored()).toEqual({});
});

test("the week board selects days in place, keeps date context and starts today's workout", async ({
  page,
}) => {
  const before = await records(page);
  const week = page.getByRole("navigation", { name: "Training week" });
  await expect(page.locator(".week-totals")).toContainText("0 of 3 planned");
  // A rest day explains what comes next without starting anything.
  await week
    .getByRole("link", { name: "Thu 8 Jan 2026: Rest, Rest day" })
    .click();
  await expect(page).toHaveURL(/\/\?date=2026-01-08$/);
  await expect(page.locator(".date-banner")).toContainText(
    "Viewing Thu 8 Jan 2026",
  );
  const panel = page.locator(".now-panel");
  await expect(panel.getByRole("heading", { name: "Rest" })).toBeVisible();
  await expect(panel).toContainText("Next: Fri 9 Jan 2026 · Strength A");
  // A planned strength day lists its exercises with guides.
  await week
    .getByRole("link", { name: "Fri 9 Jan 2026: Strength A, Not recorded" })
    .click();
  await expect(page).toHaveURL(/\/\?date=2026-01-09$/);
  const agenda = page.getByRole("region", { name: "Strength A exercises" });
  await expect(agenda.getByRole("listitem")).toHaveCount(6);
  await agenda
    .getByRole("button", { name: "How to do Goblet squat", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Goblet squat" });
  await expect(sheet).toContainText("Strength A · 3 × 8–12 reps · 2:00 rest");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/\?date=2026-01-09$/);
  await page.goBack();
  await expect(panel.getByRole("heading", { name: "Rest" })).toBeVisible();
  await page.goForward();
  await expect(agenda.getByRole("listitem")).toHaveCount(6);
  // Browsing days changes nothing in the account.
  expect(await records(page)).toEqual(before);
  // Today offers Start workout directly from the week.
  await page.getByRole("link", { name: "Return to today" }).click();
  await expect(page).toHaveURL(/\/$/);
  const start = page.getByRole("button", {
    name: "Start workout",
    exact: true,
  });
  const settings = before.find((record) => record.data.kind === "settings");
  if (settings?.data.kind !== "settings") throw Error("Missing settings");
  const today = localDate(settings.data.timezone);
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  // The default plan trains on Monday, Wednesday and Friday.
  if (![1, 3, 5].includes(weekday)) {
    await expect(start).toHaveCount(0);
    return;
  }
  await start.click();
  await expect(page).toHaveURL(/\/workout\?workoutId=/);
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const workoutId = new URL(page.url()).searchParams.get("workoutId") ?? "";
  expect((await workoutData(page, workoutId)).date).toBe(today);
});

test("plan actions stay in reach and exercise guides keep session values", async ({
  page,
}, info) => {
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  const log = page.getByRole("button", {
    name: "Log workout for Mon 5 Jan 2026",
    exact: true,
  });
  const box = await log.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw Error("Missing layout");
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: `private/screenshots/plan-actions-${info.project.name}.png`,
  });
  // The library and detail pages.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Exercises", exact: true })
    .click();
  await expect(page.locator(".exercise-tile")).toHaveCount(10);
  await page.getByRole("link", { name: /^Supported one-arm row/ }).click();
  await expect(page).toHaveURL(/\/guides\?exercise=row$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Supported one-arm row" }),
  ).toBeVisible();
  await expect(page.locator(".fact-list")).toContainText(
    "Log the reps for your left and right side separately.",
  );
  await expect(page.locator(".fact-list")).toContainText(
    "Strength A · 3 × 10–15 reps each side · 2:00 rest",
  );
  await expect(
    page.getByRole("link", { name: /Watch tutorial/ }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=KRN38chlkds");
  await page.goBack();
  await expect(
    page.getByRole("heading", { level: 1, name: "Exercises" }),
  ).toBeVisible();
  // A guide opened mid-session leaves typed values and timers in place.
  await page.goto("/?date=2026-01-05");
  const workoutId = await startPastWorkout(page);
  const weight = page.getByRole("spinbutton", {
    name: "Goblet squat set 1 weight",
    exact: true,
  });
  await weight.fill("7");
  const help = page.getByRole("button", {
    name: "How to do Goblet squat",
    exact: true,
  });
  const before = await help.boundingBox();
  // Leaving the field saves it without moving the controls.
  await page.locator("h1").click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect((await help.boundingBox())?.y).toBe(before?.y);
  await weight.fill("7.5");
  await help.click();
  const sheet = page.getByRole("dialog", { name: "Goblet squat" });
  await expect(sheet.locator(".exercise-illustration img")).toHaveAttribute(
    "src",
    "/exercise-guides/squat.png",
  );
  await sheet.getByRole("button", { name: "Close guide" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`workoutId=${workoutId}`));
  await expect(weight).toHaveValue("7.5");
  await expect(
    page.getByRole("timer", { name: "Workout elapsed time" }),
  ).toBeVisible();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  expect(
    (await workoutData(page, workoutId)).exercises[0]?.sets[0]?.loadKg,
  ).toBe(7.5);
});

test("food steps between days, adds saved meals in one tap and compares the week", async ({
  page,
}) => {
  await page.goto("/food?date=2026-01-05");
  await page.getByLabel("Meal or snack").fill("Synthetic oats");
  await page.getByLabel("Calories · kcal").fill("350");
  await page.getByLabel("Protein · g", { exact: true }).fill("12");
  await page.getByLabel("Save as a regular meal").check();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(page.locator(".food-totals")).toContainText("350");
  await expect(page.locator(".food-totals")).toContainText("kcal left");
  await page.getByRole("link", { name: "Next day, Tue 6 Jan 2026" }).click();
  await expect(page).toHaveURL(/\/food\?date=2026-01-06$/);
  await expect(page.locator(".food-screen > .entries")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Add saved meal 1: Synthetic oats to Tue 6 Jan 2026",
    })
    .click();
  await expect(
    page.getByText("Added Synthetic oats for Tue 6 Jan 2026."),
  ).toBeVisible();
  await expect(page.locator(".food-screen > .entries .list-row")).toHaveCount(
    1,
  );
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const strip = page.getByRole("list", {
    name: "Calories for the last 7 days",
  });
  await expect(
    strip.getByRole("link", { name: "Mon 5 Jan 2026: 350 kcal" }),
  ).toBeVisible();
  await strip.getByRole("link", { name: "Mon 5 Jan 2026: 350 kcal" }).click();
  await expect(page).toHaveURL(/\/food\?date=2026-01-05$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/food\?date=2026-01-06$/);
  const meals = (await records(page)).filter((r) => r.data.kind === "meal");
  expect(
    meals.map((r) => r.data.kind === "meal" && r.data.date).sort(),
  ).toEqual(["2026-01-05", "2026-01-06"]);
});

test("progress starts empty, then compares sessions, strength and bodyweight from records", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Progress", exact: true })
    .click();
  await expect(page).toHaveTitle("Progress · Fitness · bent.build");
  await expect(
    page.getByText("Finish a workout to start tracking each exercise.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No weigh-ins yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Your completed workouts and runs will appear here."),
  ).toBeVisible();
  // One finished workout.
  await page.goto("/?date=2026-01-05");
  const workoutId = await startPastWorkout(page);
  const sets = page.getByRole("button", { name: / set \d+ complete$/ });
  while ((await sets.count()) > 0) await sets.first().click();
  await page
    .getByRole("button", { name: "Finish workout", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved", {
    timeout: 20000,
  });
  await page.goto("/progress");
  const squat = page.locator(".strength-card", { hasText: "Goblet squat" });
  await expect(squat).toContainText("One session so far: 0 kg × 8");
  await expect(page.locator(".strength-card")).toHaveCount(6);
  await expect(page.locator(".session-list")).toContainText("Strength A");
  // A later session with a heavier squat, as saved by another device.
  const first = await workoutData(page, workoutId);
  const later = structuredClone(first);
  later.date = "2026-01-07";
  for (const set of later.exercises[0]?.sets ?? []) set.loadKg = 2;
  const owner = await ownerId(page);
  await withDatabase(
    (sql) =>
      sql`INSERT INTO fitness_records(owner_id,id,revision,data,deleted) VALUES(${owner},${crypto.randomUUID()},1,${sql.json(later)},false)`,
  );
  await page.reload();
  await expect(squat).toContainText("+2 kg since Mon 5 Jan");
  await expect(squat).toContainText("Heaviest completed set, kg per dumbbell");
  await expect(squat.getByRole("img")).toHaveAttribute(
    "aria-label",
    /2 sessions from 0 kg × 8 to 2 kg × 8/,
  );
  // Each session's popover shows its best set and the change from the last.
  const squatChart = squat.getByRole("img");
  const squatCard = squat.locator(".chart-card");
  await squatChart.hover({ position: { x: 1, y: 1 } });
  await expect(squatCard).toContainText("Mon 5 Jan 2026");
  await expect(squatCard).toContainText("0 kg × 8");
  await expect(squatCard).toContainText("First in this chart");
  await squat.getByRole("slider", { name: "Goblet squat sessions" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(squatCard).toContainText("Wed 7 Jan 2026");
  await expect(squatCard).toContainText("2 kg × 8");
  await expect(squatCard).toContainText("+2 kg");
  // A press on the open card selects the point beneath it, so the card
  // never blocks another point.
  const box = await squatChart.boundingBox();
  if (!box) throw new Error("The squat chart has no box.");
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await expect(squatCard).toContainText("Mon 5 Jan 2026");
  await page.keyboard.press("Escape");
  await expect(squatCard).toHaveCount(0);
  // Timed and sided exercises stay separate and show the weaker side.
  await expect(
    page.locator(".strength-card", { hasText: "Supported one-arm row" }),
  ).toContainText("each side");
  // Bodyweight compares averages only with enough weigh-ins.
  await openBodyweight(page);
  await page.locator("#weight-date").fill("2026-01-05");
  await page.getByLabel("Weight · kg", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation", { name: "Progress sections" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await expect(page.locator(".weight-summary")).toContainText("70.0 kg");
  await expect(page.locator(".weight-summary")).toContainText(
    "Record more than 7 weigh-ins to compare averages.",
  );
  await page
    .getByRole("navigation", { name: "Progress sections" })
    .getByRole("link", { name: "Sessions", exact: true })
    .click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .locator("[aria-current=page]"),
  ).toHaveText("Progress");
});

async function storedTypedValues(page: Page, key: string) {
  const raw = await page.evaluate(
    (prefix) =>
      Object.entries(localStorage).filter(
        ([key]) => key === prefix || key.startsWith(`${prefix}:entry:`),
      ),
    key,
  );
  const fields: Record<
    string,
    { text: string; base: string | null; units: "kg" | "lb" | null }
  > = {};
  const entry = z.object({
    text: z.string(),
    base: z.string().nullable(),
    units: z.enum(["kg", "lb"]).nullable(),
  });
  for (const [recordKey, value] of raw) {
    if (recordKey === key)
      Object.assign(
        fields,
        z.record(z.string(), entry).parse(JSON.parse(value)),
      );
    else {
      const parsed = z
        .object({ field: z.string(), entry })
        .parse(JSON.parse(value));
      fields[parsed.field] = parsed.entry;
    }
  }
  return fields;
}

test("reorganise days manually preserves the next week and recovers after reload", async ({
  page,
}, info) => {
  await mkdir("private/reorganise", { recursive: true });
  await page.screenshot({
    path: `private/reorganise/week-after-${info.project.name}.png`,
    fullPage: true,
  });
  const before = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  const original = before.records.find((r) => r.data.kind === "settings");
  if (original?.data.kind !== "settings") throw Error("Missing settings");
  const monday = addDays(mondayOf(localDate(original.data.timezone)), 7);
  const thursday = addDays(monday, 3);
  const routine = scheduled(original.data, monday).routine;
  if (!routine) throw Error("Missing routine");
  await page.locator("#view-date").fill(monday);
  await page
    .getByRole("button", { name: "Reorganise week", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Move a planned session" });
  await panel.getByLabel("Session to move").selectOption(monday);
  await panel.getByLabel("Move to", { exact: true }).selectOption(thursday);
  await page.screenshot({
    path: `private/reorganise/move-${info.project.name}.png`,
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Apply move" }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const exported = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  );
  const record = exported.records.find((r) => r.data.kind === "settings");
  if (record?.data.kind !== "settings") throw Error("Missing updated settings");
  expect(scheduled(record.data, monday).type).toBe("rest");
  expect(scheduled(record.data, thursday).routine?.id).toBe(routine.id);
  expect(scheduled(record.data, addDays(monday, 7))).toEqual(
    scheduled(original.data, addDays(monday, 7)),
  );
  expect(record.data.schedule).toEqual(original.data.schedule);
  expect(exported.records.filter((r) => r.data.kind !== "settings")).toEqual(
    before.records.filter((r) => r.data.kind !== "settings"),
  );
  await page.locator("#view-date").fill(thursday);
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    routine.name,
  );
  await page.goBack();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Reset week to repeating plan" })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  const reset = exportSchema
    .parse(await (await page.request.get("/api/export")).json())
    .records.find((r) => r.data.kind === "settings");
  if (reset?.data.kind !== "settings") throw Error("Missing reset settings");
  expect(reset.data.dayPlans).toEqual({});
});

test("reorganise rejects a stale plan when another tab saves settings", async ({
  page,
  context,
}) => {
  const monday = addDays(mondayOf(localDate("UTC")), 7);
  await page.locator("#view-date").fill(monday);
  await page
    .getByRole("button", { name: "Reorganise week", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Move a planned session" });
  const other = await context.newPage();
  await other.goto("/settings");
  await other
    .locator("#goal")
    .fill("Synthetic changed goal for conflict coverage");
  await other
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(other.locator(".sync-state")).toHaveText("Saved");
  await panel.getByRole("button", { name: "Apply move" }).click();
  await expect(panel.getByRole("alert")).toContainText("Your plan changed");
  const records = exportSchema.parse(
    await (await page.request.get("/api/export")).json(),
  ).records;
  const record = records.find((r) => r.data.kind === "settings");
  if (record?.data.kind !== "settings") throw Error("Missing settings");
  expect(record.data.goal).toBe("Synthetic changed goal for conflict coverage");
  expect(record.data.dayPlans).toEqual({});
  await other.close();
});
