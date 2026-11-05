import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { ActionStore } from "./action-store.js";
import { createMcpServer } from "./mcp-server.js";
import { MockTeslaAdapter } from "./tesla-adapter.js";

import type { TeslaBridgeConfig } from "./config.js";

const config: TeslaBridgeConfig = {
  mode: "mock",
  actionsEnabled: true,
  accessToken: undefined,
  clientId: undefined,
  tokenFile: "/tmp/tesla-bridge-test-tokens.json",
  tokenEndpoint: "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token",
  fleetApiBaseUrl: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  commandProxyUrl: undefined,
  port: 8787,
};

const preparedActionResultSchema = z.object({
  structuredContent: z.object({
    actionId: z.string().uuid(),
    executed: z.literal(false),
  }),
});

const executedActionResultSchema = z.object({
  structuredContent: z.object({
    result: z.object({ succeeded: z.literal(true) }),
  }),
});

void test("MCP exposes reads and enforces prepare-before-execute", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config, new MockTeslaAdapter(), new ActionStore());
  const client = new Client({ name: "tesla-bridge-test", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "tesla_list_vehicles",
        "tesla_get_vehicle_status",
        "tesla_prepare_action",
        "tesla_execute_action",
      ]
    );

    const preparedResponse = await client.callTool({
      name: "tesla_prepare_action",
      arguments: {
        vin: "MOCKVIN0000000001",
        action: { type: "start_climate" },
        reason: "User asked to warm the car",
      },
    });
    const prepared = preparedActionResultSchema.parse(preparedResponse);

    const executedResponse = await client.callTool({
      name: "tesla_execute_action",
      arguments: { actionId: prepared.structuredContent.actionId },
    });
    const executed = executedActionResultSchema.parse(executedResponse);
    assert.equal(executed.structuredContent.result.succeeded, true);

    const replayResponse = await client.callTool({
      name: "tesla_execute_action",
      arguments: { actionId: prepared.structuredContent.actionId },
    });
    assert.equal(replayResponse.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
