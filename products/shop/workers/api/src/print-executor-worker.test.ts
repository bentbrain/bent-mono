import { expect, it } from "vitest";

import worker, { PrintAssetExecution } from "../../print-executor/src/index";
import { PrintAssetExecution as Scheduler } from "./print-execution-object";

it("exports the scheduler only through its namespace and exposes no public HTTP operation", async () => {
  expect(PrintAssetExecution).toBe(Scheduler);
  const response = worker.fetch();
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
});
