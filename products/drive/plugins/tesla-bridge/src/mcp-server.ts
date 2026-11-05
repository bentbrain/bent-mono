import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { describeAction, vehicleActionSchema, vinSchema } from "./domain.js";

import type { ActionStore } from "./action-store.js";
import type { TeslaBridgeConfig } from "./config.js";
import type { TeslaAdapter } from "./tesla-adapter.js";

const vinInput = vinSchema.describe("VIN returned by tesla_list_vehicles");

export function createMcpServer(
  config: TeslaBridgeConfig,
  adapter: TeslaAdapter,
  actionStore: ActionStore
): McpServer {
  const server = new McpServer(
    { name: "tesla-bridge", version: "0.2.0" },
    {
      instructions:
        "Use read tools freely. For vehicle changes, prepare the exact action first and execute only after explicit user approval. Never invent VINs or action IDs. Unsupported high-risk actions must remain unsupported.",
    }
  );

  server.registerTool(
    "tesla_list_vehicles",
    {
      title: "List linked Tesla vehicles",
      description: "Lists Tesla vehicles available to the authenticated connection.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const vehicles = await adapter.listVehicles();
        return {
          content: [{ type: "text", text: `Found ${vehicles.length} linked vehicle(s).` }],
          structuredContent: { vehicles },
        };
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  server.registerTool(
    "tesla_get_vehicle_status",
    {
      title: "Get Tesla vehicle status",
      description: "Returns current battery, charging, lock, cabin climate, and Sentry state for one linked Tesla.",
      inputSchema: { vin: vinInput },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ vin }) => {
      try {
        const status = await adapter.getVehicleStatus(vin);
        return {
          content: [
            {
              type: "text",
              text: `${status.displayName} is ${status.state}; battery ${status.batteryLevel ?? "unknown"}%.`,
            },
          ],
          structuredContent: { status },
        };
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  server.registerTool(
    "tesla_prepare_action",
    {
      title: "Prepare a Tesla action",
      description:
        "Validates and prepares one supported low-risk vehicle action. This does not send a command to the vehicle.",
      inputSchema: {
        vin: vinInput,
        action: vehicleActionSchema,
        reason: z.string().min(1).max(240).describe("Why the user requested this exact action"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ vin, action, reason }) => {
      try {
        const status = await adapter.getVehicleStatus(vin);
        const pending = actionStore.prepare(vin, action, reason);
        const description = describeAction(action);
        return {
          content: [
            {
              type: "text",
              text: `Prepared to ${description} for ${status.displayName}. This has not executed. Approval is required before execution.`,
            },
          ],
          structuredContent: {
            actionId: pending.id,
            vin: pending.vin,
            action: pending.action,
            description,
            expiresAt: pending.expiresAt,
            executed: false,
          },
        };
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  server.registerTool(
    "tesla_execute_action",
    {
      title: "Execute an approved Tesla action",
      description:
        "Executes one previously prepared action. This changes private vehicle state and must be shown to the user for approval.",
      inputSchema: {
        actionId: z.string().uuid().describe("Unexpired ID returned by tesla_prepare_action"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ actionId }) => {
      try {
        if (!config.actionsEnabled) {
          throw new Error("Vehicle actions are disabled. Set TESLA_ACTIONS_ENABLED=true to enable them.");
        }
        const pending = actionStore.consume(actionId);
        const result = await adapter.executeAction(pending.vin, pending.action);
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: {
            actionId: pending.id,
            vin: pending.vin,
            action: pending.action,
            result,
          },
        };
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  return server;
}

type ToolFailure = {
  content: { type: "text"; text: string }[];
  structuredContent: { error: string };
  isError: true;
};

function toolFailure(error: unknown): ToolFailure {
  const message = error instanceof Error ? error.message : "Unknown Tesla Bridge error.";
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}
