import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { mkdir } from "node:fs/promises";
import { database } from "../src/server/db";
import { settleWrites, trackWrites } from "./quiescence";
import { z } from "zod";
const syntheticEmails = [
  "fitness-a+clerk_test@example.com",
  "fitness-b+clerk_test@example.com",
];
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
test.beforeEach(async () => {
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_"))
    throw new Error("Provider checks require a Clerk development application.");
  for (const email of syntheticEmails) {
    const r = await fetch(
      "https://api.clerk.com/v1/users?email_address=" +
        encodeURIComponent(email),
      { headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` } },
    );
    if (!r.ok) throw new Error("Could not load synthetic users.");
    const users = z.array(z.object({ id: z.string() })).parse(await r.json());
    for (const user of users) {
      const sql = database();
      // Plan proposals reference the account. Databases that haven't had
      // the proposals table applied yet have none to remove.
      const [{ proposals }] =
        await sql`SELECT to_regclass('fitness_plan_proposals') IS NOT NULL AS proposals`;
      if (proposals)
        await sql`DELETE FROM fitness_plan_proposals WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_photos WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_operations WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_records WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_accounts WHERE owner_id=${user.id}`;
    }
  }
});
test.afterEach(async ({ context }) => {
  await settleWrites(context);
});
test.afterAll(async () => {
  await database().end();
});

test.beforeAll(async () => {
  await clerkSetup({ publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY });
});
test.beforeEach(async ({ page, context }) => {
  trackWrites(context);
  await setupClerkTestingToken({ page });
});
test("real accounts sync workout drafts, food and weight and isolate photos and exports", async ({
  page,
  browser,
}, info) => {
  const writes: { url: string; body: string }[] = [];
  page.on("request", (request) => {
    const body = request.postData();
    if (
      request.method() === "POST" &&
      request.url().includes("/_serverFn/") &&
      body
    )
      writes.push({ url: request.url(), body });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Track strength sessions, runs, food and bodyweight.",
    }),
  ).toBeVisible();
  await clerk.signIn({
    page,
    emailAddress: "fitness-a+clerk_test@example.com",
  });
  await page.reload();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  const setup = page.getByRole("button", { name: "Set up my plan" });
  if (await setup.isVisible()) await setup.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your week" }),
  ).toBeVisible();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await expect(page.locator("[data-feedback-host]")).toBeAttached();
  await page.getByLabel("Choose date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await page.getByRole("link", { name: "Edit repeating week" }).click();
  await page.getByLabel("Plan start date").fill("2026-01-05");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.getByLabel("Choose date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await mkdir("private/screenshots", { recursive: true });
  await page.screenshot({
    path: `private/screenshots/today-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "View workout plan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Log workout for Mon 5 Jan 2026" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: /^Goblet squat set 1 weight(,|$)/ })
    .fill("8");
  await page
    .getByRole("button", { name: "Goblet squat set 1 complete", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.context().setOffline(true);
  await page
    .getByRole("spinbutton", { name: /^Goblet squat set 2 weight(,|$)/ })
    .fill("9");
  await expect(page.getByRole("status").first()).toContainText("Offline");
  await page
    .reload({ waitUntil: "domcontentloaded", timeout: 15000 })
    .catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !error.message.includes("ERR_INTERNET_DISCONNECTED")
      )
        throw error;
    });
  await page.context().setOffline(false);
  await page.goto("/");
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("spinbutton", {
      name: /^Goblet squat set 2 weight(,|$)/,
    }),
  ).toHaveValue("9");
  await page
    .getByRole("button", { name: "How to do Goblet squat", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Goblet squat" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Watch tutorial/ }).first(),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=MeIiIdhvXT4");
  const illustrated = page.locator(".exercise-illustration img").first();
  await expect(illustrated).toHaveAttribute(
    "src",
    "/exercise-guides/squat.png",
  );
  await expect
    .poll(() =>
      illustrated.evaluate(
        (element) =>
          element instanceof HTMLImageElement &&
          element.complete &&
          element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(
    page.locator(".exercise-illustration a").first(),
  ).toHaveAttribute("target", "_blank");
  await page.screenshot({
    path: `private/screenshots/workout-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", {
      name: /^Goblet squat set 2 weight(,|$)/,
    }),
  ).toHaveValue("9");
  await page.getByRole("link", { name: "Food", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Food" }),
  ).toBeVisible();
  await page.getByLabel("Choose date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await page.getByLabel("Meal or snack").fill("Synthetic lunch");
  await page.getByLabel("Calories · kcal").fill("600");
  await page.getByLabel("Protein · g", { exact: true }).fill("35");
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await openBodyweight(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Bodyweight" }),
  ).toBeVisible();
  await page.getByLabel("Choose date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await page.getByLabel("Weight · kg", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Upload equipment photo").setInputFiles({
    name: "synthetic-equipment.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  const photo = page.getByRole("img", {
    name: "synthetic-equipment.png",
    exact: true,
  });
  await expect(photo).toBeVisible();
  const photoUrl = await photo.getAttribute("src");
  if (!photoUrl) throw new Error("Missing private photo URL.");
  const ownPhoto = await page.request.get(photoUrl);
  expect(ownPhoto.status()).toBe(200);
  expect(ownPhoto.headers()["cache-control"]).toContain("no-store");
  const ownExport = await page.request.get("/api/export");
  expect(ownExport.status()).toBe(200);
  const exported = z
    .object({
      records: z.array(z.unknown()),
      photos: z.array(z.object({ name: z.string() })),
    })
    .parse(await ownExport.json());
  expect(
    exported.photos.some((p) => p.name === "synthetic-equipment.png"),
  ).toBe(true);
  const lastWrite = writes.at(-1);
  if (!lastWrite)
    throw new Error("Missing server write for CSRF verification.");
  expect(
    (
      await page.request.post(lastWrite.url, {
        headers: {
          Origin: "https://example.invalid",
          "Content-Type": "application/json",
        },
        data: lastWrite.body,
      })
    ).status(),
  ).toBe(403);
  const contextA2 = await browser.newContext({
    baseURL: "http://localhost:3025",
  });
  const pageA2 = await contextA2.newPage();
  await setupClerkTestingToken({ page: pageA2 });
  await pageA2.goto("/");
  await clerk.signIn({ page: pageA2, emailAddress: syntheticEmails[0] ?? "" });
  await pageA2.reload();
  await pageA2
    .getByRole("link", { name: "Resume workout", exact: true })
    .click();
  await expect(
    pageA2.getByRole("spinbutton", {
      name: /^Goblet squat set 2 weight(,|$)/,
    }),
  ).toHaveValue("9");
  await openBodyweight(pageA2);
  await expect(
    pageA2.getByRole("heading", { level: 1, name: "Bodyweight" }),
  ).toBeVisible();
  await pageA2.getByLabel("Choose date").fill("2026-01-05");
  await expect(pageA2).toHaveURL(/date=2026-01-05/);
  await expect(pageA2.getByLabel("Date", { exact: true })).toHaveValue(
    "2026-01-05",
  );
  await pageA2.getByLabel("Weight · kg", { exact: true }).fill("71");
  await pageA2.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(pageA2.getByRole("status").first()).toHaveText("Saved");
  await openBodyweight(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Bodyweight" }),
  ).toBeVisible();
  await page.getByLabel("Choose date").fill("2026-01-05");
  await expect(page).toHaveURL(/date=2026-01-05/);
  await page.getByLabel("Weight · kg", { exact: true }).fill("72");
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use cloud version for this record" })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await pageA2.getByRole("link", { name: "Settings", exact: true }).click();
  await pageA2
    .getByLabel("Goal", { exact: true })
    .fill("Synthetic private cloud goal");
  await pageA2
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(pageA2.getByRole("status").first()).toHaveText("Saved");
  await page.getByLabel("Goal", { exact: true }).fill("Stale device goal");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use cloud version for this record" })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await expect(page.getByLabel("Goal", { exact: true })).toHaveValue(
    "Synthetic private cloud goal",
  );
  await page
    .getByRole("radiogroup", { name: "Display units" })
    .getByRole("radio", { name: "Pounds" })
    .click();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await pageA2.reload();
  await pageA2.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(pageA2.getByLabel("Goal", { exact: true })).toHaveValue(
    "Synthetic private cloud goal",
  );
  await contextA2.close();
  await openBodyweight(page);
  const pounds = page.getByLabel("Weight · lb", { exact: true });
  await pounds.fill("154.35");
  expect(
    await pounds.evaluate(
      (element) =>
        element instanceof HTMLInputElement && element.checkValidity(),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByText("All weigh-ins", { exact: true }).click();
  await expect(
    page.locator(".list-row").getByText("154.35 lb", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: /Repeating week and routines/ }).click();
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    await page
      .getByRole("radiogroup", { name: day, exact: true })
      .getByRole("radio", { name: "Rest" })
      .click();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.getByRole("link", { name: "Resume workout", exact: true }).click();
  await page.getByText("Discard this workout", { exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await expect(
    page.getByText("No training days are scheduled.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log run", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Record an unscheduled run", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Record your completed run" }),
  ).toBeVisible();
  // Keep the hosted loader intact and intercept only its isolated panel UI.
  // Its real selection handler must redact the goal and remove it from ancestor context.
  await page.route("https://toolbar.bent.build/toolbar?**", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<pre id="context"></pre><script>addEventListener('message',event=>{if(event.data.type==='feedback:selected')document.querySelector('#context').textContent=JSON.stringify(event.data.context)});</script>`,
    }),
  );
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Week", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".subtitle")).toHaveText(
    "Synthetic private cloud goal",
  );
  const panel = page
    .frames()
    .find((frame) =>
      frame.url().startsWith("https://toolbar.bent.build/toolbar?"),
    );
  if (!panel) throw new Error("Toolbar panel did not load.");
  await expect(panel.locator("#context")).toBeAttached();
  for (const selector of [".subtitle", ".content > section"]) {
    await panel.evaluate(() =>
      window.parent.postMessage(
        { type: "feedback:select" },
        "http://localhost:3025",
      ),
    );
    await expect(page.locator("html")).toHaveCSS("cursor", "crosshair");
    await page.locator(selector).dispatchEvent("click");
    await expect(panel.locator("#context")).not.toContainText(
      "Synthetic private cloud goal",
    );
    await expect(panel.locator("#context")).toContainText(
      selector === ".subtitle" ? '"tag":"p"' : '"tag":"section"',
    );
    if (selector === ".subtitle")
      await expect(panel.locator("#context")).toContainText(
        "[Private element]",
      );
  }

  const contextB = await browser.newContext({
    baseURL: "http://localhost:3025",
  });
  const pageB = await contextB.newPage();
  await setupClerkTestingToken({ page: pageB });
  await pageB.goto("/");
  await clerk.signIn({ page: pageB, emailAddress: syntheticEmails[1] ?? "" });
  await pageB.reload();
  await expect(
    pageB.getByRole("button", { name: "Set up my plan" }),
  ).toBeVisible();
  expect((await pageB.request.get(photoUrl)).status()).toBe(404);
  const otherExport = z
    .object({ records: z.array(z.unknown()), photos: z.array(z.unknown()) })
    .parse(await (await pageB.request.get("/api/export")).json());
  expect(otherExport.records).toHaveLength(0);
  expect(otherExport.photos).toHaveLength(0);
  await clerk.signOut({ page: pageB });
  expect((await pageB.request.get(photoUrl)).status()).toBe(403);
  await clerk.signIn({
    page: pageB,
    emailAddress: "fitness-denied+clerk_test@example.com",
  });
  await pageB.reload();
  await expect(
    pageB.getByText(
      "This account needs an invitation. Contact the app owner.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await pageB.request.get("/api/export")).status()).toBe(403);
  await contextB.close();
});
