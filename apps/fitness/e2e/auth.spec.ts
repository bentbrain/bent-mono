import { expect, test } from "@playwright/test";
import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { mkdir } from "node:fs/promises";
import { database } from "../src/server/db";
import { z } from "zod";
const syntheticEmails = [
  "fitness-a+clerk_test@example.com",
  "fitness-b+clerk_test@example.com",
];
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
      await sql`DELETE FROM fitness_photos WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_operations WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_records WHERE owner_id=${user.id}`;
      await sql`DELETE FROM fitness_accounts WHERE owner_id=${user.id}`;
    }
  }
});
test.afterAll(async () => {
  await database().end();
});

test.beforeAll(async () => {
  await clerkSetup({ publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY });
});
test.beforeEach(async ({ page }) => {
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
    page.getByRole("heading", { name: "Your next good habit." }),
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
    page.getByRole("heading", { name: "Keep showing up." }),
  ).toBeVisible();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await expect(page.locator("[data-feedback-host]")).toBeAttached();
  await page.locator("#view-date").fill("2026-01-05");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Plan start date").fill("2026-01-05");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Today", exact: true })
    .click();
  await mkdir("private/screenshots", { recursive: true });
  await page.screenshot({
    path: `private/screenshots/today-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start workout" }).click();
  await expect(
    page.getByRole("heading", { name: "Strength A", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Goblet squat set 1 weight", exact: true })
    .fill("8");
  await page
    .getByRole("button", { name: "Goblet squat set 1 complete", exact: true })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.context().setOffline(true);
  await page
    .getByRole("spinbutton", { name: "Goblet squat set 2 weight", exact: true })
    .fill("9");
  await expect(page.getByRole("status").first()).toContainText("Offline");
  await page.context().setOffline(false);
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.reload();
  await expect(
    page.getByRole("spinbutton", {
      name: "Goblet squat set 2 weight",
      exact: true,
    }),
  ).toHaveValue("9");
  await page
    .getByText("How to do this exercise", { exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: /Watch tutorial/ }).first(),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=MeIiIdhvXT4");
  await page.screenshot({
    path: `private/screenshots/workout-${info.project.name}.png`,
    fullPage: true,
  });
  await page.locator("#view-date").fill("2026-01-05");
  await page.getByRole("button", { name: "Food", exact: true }).click();
  await page.getByLabel("Meal or snack").fill("Synthetic lunch");
  await page.getByLabel("Calories · kcal").fill("600");
  await page.getByLabel("Protein · g", { exact: true }).fill("35");
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("button", { name: "Body", exact: true }).click();
  await page.getByLabel("Weight · kg", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await expect(
    pageA2.getByRole("spinbutton", {
      name: "Goblet squat set 2 weight",
      exact: true,
    }),
  ).toHaveValue("9");
  await pageA2.locator("#view-date").fill("2026-01-05");
  await pageA2.getByRole("button", { name: "Body", exact: true }).click();
  await pageA2.getByLabel("Weight · kg", { exact: true }).fill("71");
  await pageA2.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(pageA2.getByRole("status").first()).toHaveText("Saved");
  await page.getByRole("button", { name: "Body", exact: true }).click();
  await page.getByLabel("Weight · kg", { exact: true }).fill("72");
  await page.getByRole("button", { name: "Save weigh-in" }).click();
  await expect(
    page.getByRole("heading", { name: "Review the conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use cloud version for this record" })
    .click();
  await expect(page.getByRole("status").first()).toHaveText("Saved");
  await contextA2.close();
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
