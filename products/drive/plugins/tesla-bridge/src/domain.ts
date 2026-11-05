import { z } from "zod";

import { vehicleStatusSchema as baseVehicleStatusSchema } from "@bent-build/tesla-contracts";

export {
  normalizeVehicleState,
  vehicleSummarySchema,
  vinSchema,
} from "@bent-build/tesla-contracts";

export type {
  VehicleSummary,
} from "@bent-build/tesla-contracts";

export const vehicleStatusSchema = baseVehicleStatusSchema.extend({
  dataSource: z.enum(["mock", "fleet-api"]),
});

export type VehicleStatus = z.infer<typeof vehicleStatusSchema>;

export const vehicleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("lock") }),
  z.object({ type: z.literal("start_climate") }),
  z.object({ type: z.literal("stop_climate") }),
  z.object({
    type: z.literal("set_charge_limit"),
    percent: z.number().int().min(50).max(100),
  }),
  z.object({ type: z.literal("start_charging") }),
  z.object({ type: z.literal("stop_charging") }),
  z.object({ type: z.literal("enable_sentry") }),
  z.object({ type: z.literal("disable_sentry") }),
]);

export type VehicleAction = z.infer<typeof vehicleActionSchema>;

export const actionResultSchema = z.object({
  succeeded: z.boolean(),
  message: z.string(),
  completedAt: z.string().datetime(),
  dataSource: z.enum(["mock", "fleet-api"]),
});

export type ActionResult = z.infer<typeof actionResultSchema>;

export function describeAction(action: VehicleAction): string {
  switch (action.type) {
    case "lock":
      return "lock the vehicle";
    case "start_climate":
      return "start climate preconditioning";
    case "stop_climate":
      return "stop climate preconditioning";
    case "set_charge_limit":
      return `set the charge limit to ${action.percent}%`;
    case "start_charging":
      return "start charging";
    case "stop_charging":
      return "stop charging";
    case "enable_sentry":
      return "enable Sentry Mode";
    case "disable_sentry":
      return "disable Sentry Mode";
  }
}
