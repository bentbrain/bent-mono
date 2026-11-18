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
import { localDate, recordSchema } from "../src/domain";
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
  await expect(page).toHaveURL(/date=2026-01-05/);
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
  await expect(page).toHaveURL(/\/plan\?date=2026-01-05&routineId=/);
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
    page.getByRole("heading", { name: "Keep showing up." }),
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
  ).toHaveText("+Food");
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
    page.getByRole("heading", { name: "Food · Tue 6 Jan 2026" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/food$/);
  await expect(page.locator("#view-date")).toHaveValue(today);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
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
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Open exercise guides" }).click();
  await expect(page).toHaveURL(/\/guides/);
  await expect(page.locator("#view-date")).toHaveCount(0);
  await expect(
    page.getByRole("navigation").locator("[aria-current=page]"),
  ).toHaveText("?Guides");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
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
  await page.getByRole("link", { name: "Back to Today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  // While a workout is active, Today shows only the resume card.
  await expect(
    page.getByRole("link", { name: "View workout plan", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Mon 5 Jan 2026: Strength A, Not recorded" })
    .click();
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
    page.getByRole("heading", { name: "Keep showing up." }),
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
  await page.locator(".routine-editor > summary").first().click();
  await page.getByLabel("Sets", { exact: true }).first().fill("1");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".sync-state")).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Today", exact: true })
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
  await expect(page.locator(".section-heading")).toContainText("0/11 sets");
});

test("toolbar configure, navigation and selection redact private activity URL parameters", async ({
  page,
}) => {
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
});

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
  await page.getByRole("link", { name: "Today", exact: true }).click();
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
  const owner = await page.evaluate(() => {
    const value: unknown = Reflect.get(window, "Clerk");
    const user: unknown =
      value && typeof value === "object" ? Reflect.get(value, "user") : null;
    const id: unknown =
      user && typeof user === "object" ? Reflect.get(user, "id") : null;
    return typeof id === "string" ? id : "";
  });
  expect(owner).not.toBe("");
  await page.getByRole("link", { name: "Back to Today", exact: true }).click();
  // Simulate a closed tab that kept typed values without saving them.
  await page.evaluate(
    ({ key }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          "0:0:value": { text: "11", base: "8" },
          "0:1:value": { text: "12", base: "5" },
          notes: { text: "Recovered note", base: "" },
        }),
      ),
    { key: `bent:fitness:inputs:v1:${owner}:${workoutId}` },
  );
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
  await page.getByRole("link", { name: "Today", exact: true }).click();
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
  await expect(page.getByText(/Strength days take turns/)).toBeVisible();
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
  await page.getByLabel("Meal or snack").fill("synthetic oats");
  await page.getByLabel("Calories · kcal").fill("350.5");
  await page.getByLabel("Protein · g", { exact: true }).fill("12");
  await page.getByLabel("Save as a regular meal").check();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(
    page.getByText("It is already in Regular meals.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Add Synthetic oats to / }),
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
  await page.getByRole("link", { name: "Body", exact: true }).click();
  for (const [date, kg] of [
    ["2026-01-05", "70"],
    ["2026-01-06", "71.2"],
  ]) {
    await page.locator("#weight-date").fill(date);
    await page.getByLabel("Weight · kg", { exact: true }).fill(kg);
    await page.getByRole("button", { name: "Save weigh-in" }).click();
    await expect(page.locator(".sync-state")).toHaveText("Saved");
  }
  await expect(page.locator(".big-number")).toHaveText("70.6 kg");
  const chart = page.locator(".weight-chart");
  await expect(chart).toContainText("High 71.2 kg");
  await expect(chart).toContainText("Low 70.0 kg");
  await expect(chart).toContainText("Mon 5 Jan");
  await expect(chart).toContainText("Tue 6 Jan");
  await page.getByText("All weigh-ins", { exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Remove weigh-in Tue 6 Jan 2026" })
    .click();
  await expect(chart).not.toContainText("High 71.2 kg");
});
