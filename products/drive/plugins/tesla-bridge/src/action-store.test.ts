import assert from "node:assert/strict";
import test from "node:test";

import { ActionStore } from "./action-store.js";

void test("prepared actions are single-use", () => {
  const store = new ActionStore();
  const pending = store.prepare("MOCKVIN0000000001", { type: "lock" }, "User requested lock");

  assert.equal(store.consume(pending.id).id, pending.id);
  assert.throws(() => store.consume(pending.id), /not found|already been used/);
});

void test("expired actions cannot execute", () => {
  const store = new ActionStore(1_000);
  const preparedAt = new Date("2026-07-10T00:00:00.000Z");
  const pending = store.prepare(
    "MOCKVIN0000000001",
    { type: "start_climate" },
    "User requested climate",
    preparedAt
  );

  assert.throws(
    () => store.consume(pending.id, new Date("2026-07-10T00:00:02.000Z")),
    /expired/
  );
});
