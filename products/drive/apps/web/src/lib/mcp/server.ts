import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";

import {
  vehicleStatusSchema,
  vehicleSummarySchema,
  vinSchema,
} from "@bent-build/tesla-contracts";

import { hashToken } from "../crypto";
import { AppRuntime } from "../runtime";
import { getTeslaVehicleStatus, listTeslaVehicles } from "../tesla";

import type { AppConfig } from "../config";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const oauthSecuritySchemes = [{ type: "oauth2", scopes: ["tesla.read"] }];

const toolErrorDetailsSchema = z.object({
  _tag: z.string().optional(),
  message: z.string().optional(),
  operation: z.string().optional(),
  status: z.number().int().optional(),
});

const vehicleSummaryOutput = z.object({
  vehicles: z.array(vehicleSummarySchema),
});

const vehicleStatusOutput = z.object({
  status: vehicleStatusSchema,
});

export function createHostedMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: "bent-drive-copilot", version: "0.3.0" },
    {
      instructions:
        "Use these tools only for the Tesla account linked through OAuth. Read vehicle state freely after authentication. Vehicle-changing commands are not exposed in this read-only release.",
    }
  );

  const listConfig = {
    title: "List linked Tesla vehicles",
    description: "Lists Tesla vehicles connected by the current authenticated user.",
    inputSchema: {},
    outputSchema: vehicleSummaryOutput,
    securitySchemes: oauthSecuritySchemes,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { securitySchemes: oauthSecuritySchemes },
  };
  server.registerTool("tesla_list_vehicles", listConfig, (_input, extra) => {
    const connectionId = extra.authInfo?.extra?.connectionId;
    if (typeof connectionId !== "string") {
      return authenticationFailure(config);
    }
    const program = listTeslaVehicles(connectionId).pipe(
      Effect.map((vehicles) => {
        const structuredContent = { vehicles };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        } satisfies CallToolResult;
      }),
      Effect.catchAll((error) =>
        reportToolFailure(error, connectionId, "tesla_list_vehicles")
      ),
      Effect.annotateLogs({ connectionId, toolName: "tesla_list_vehicles" }),
      Effect.withSpan("mcp.tool.tesla_list_vehicles")
    );
    return AppRuntime.runPromise(program);
  });

  const statusConfig = {
    title: "Get Tesla vehicle status",
    description:
      "Returns current battery, range, charging, lock, cabin climate, and Sentry state for one linked Tesla.",
    inputSchema: {
      vin: vinSchema.describe("VIN returned by tesla_list_vehicles"),
    },
    outputSchema: vehicleStatusOutput,
    securitySchemes: oauthSecuritySchemes,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { securitySchemes: oauthSecuritySchemes },
  };
  server.registerTool("tesla_get_vehicle_status", statusConfig, ({ vin }, extra) => {
    const connectionId = extra.authInfo?.extra?.connectionId;
    if (typeof connectionId !== "string") {
      return authenticationFailure(config);
    }
    const program = getTeslaVehicleStatus(connectionId, vin).pipe(
      Effect.map((status) => {
        const structuredContent = { status };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        } satisfies CallToolResult;
      }),
      Effect.catchAll((error) =>
        reportToolFailure(error, connectionId, "tesla_get_vehicle_status")
      ),
      Effect.annotateLogs({
        connectionId,
        vinFingerprint: hashToken(vin).slice(0, 16),
        toolName: "tesla_get_vehicle_status",
      }),
      Effect.withSpan("mcp.tool.tesla_get_vehicle_status")
    );
    return AppRuntime.runPromise(program);
  });

  return server;
}

function authenticationFailure(config: AppConfig): CallToolResult {
  return {
    content: [{ type: "text", text: "Connect your Tesla account to continue." }],
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${config.protectedResourceMetadataUrl}", error="invalid_token", error_description="Connect your Tesla account to continue"`,
      ],
    },
    isError: true,
  };
}

function toolFailure(error: unknown): CallToolResult {
  const details = toolErrorDetailsSchema.safeParse(error);
  const message = details.success ? userFacingToolError(details.data) : genericToolError;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function reportToolFailure(error: unknown, connectionId: string, toolName: string) {
  const details = toolErrorDetailsSchema.safeParse(error);
  const annotations = details.success
    ? {
        connectionId,
        toolName,
        errorTag: details.data._tag ?? "UnknownError",
        errorOperation: details.data.operation ?? "unknown",
        errorStatus: details.data.status ?? 0,
        errorMessage: details.data.message ?? "",
      }
    : { connectionId, toolName, errorTag: "UnparseableError" };
  return Effect.logError("mcp.tool.failed").pipe(
    Effect.annotateLogs(annotations),
    Effect.as(toolFailure(error))
  );
}

const genericToolError = "Bent Drive Copilot could not read the vehicle.";

function userFacingToolError(details: z.infer<typeof toolErrorDetailsSchema>): string {
  if (details._tag === "TeslaHttpError" && details.status === 408) {
    return "The Tesla is asleep or offline, so detailed live status is unavailable until it wakes.";
  }
  if (details._tag === "TeslaHttpError" && details.status) {
    return `Tesla Fleet API returned HTTP ${details.status} while reading the vehicle.`;
  }
  if (details._tag === "TeslaResponseDecodeError") {
    return "Tesla returned an unreadable response while the vehicle status was being retrieved.";
  }
  const message = details.message?.trim();
  return message === undefined || message.length === 0 ? genericToolError : message;
}
