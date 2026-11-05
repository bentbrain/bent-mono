import assert from "node:assert/strict";
import test from "node:test";

import { createInviteInputSchema, inviteIdSchema } from "./invites";

void test("invite input normalizes a GitHub username and coerces expiry days", () => {
  const parsed = createInviteInputSchema.parse({
    githubUsername: "  @Octo-Cat ",
    expiresInDays: "14",
  });

  assert.deepEqual(parsed, { githubUsername: "octo-cat", expiresInDays: 14 });
});

void test("invite input rejects invalid GitHub usernames and excessive expiry", () => {
  assert.equal(
    createInviteInputSchema.safeParse({ githubUsername: "not--a-user", expiresInDays: 14 })
      .success,
    false
  );
  assert.equal(
    createInviteInputSchema.safeParse({ githubUsername: "octocat", expiresInDays: 366 }).success,
    false
  );
});

void test("invite identifiers must be UUIDs", () => {
  assert.equal(inviteIdSchema.safeParse("not-a-uuid").success, false);
  assert.equal(inviteIdSchema.safeParse("df35e5f0-e837-4e98-9f82-87c2a9b5c2f4").success, true);
});
