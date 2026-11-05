import { z } from "zod";

export const vinSchema = z.string().min(5).max(32);

export const vehicleStateSchema = z.enum(["online", "asleep", "offline", "unknown"]);

export type VehicleState = z.infer<typeof vehicleStateSchema>;

export const vehicleSummarySchema = z.object({
  vin: vinSchema,
  displayName: z.string().min(1),
  state: vehicleStateSchema,
});

export type VehicleSummary = z.infer<typeof vehicleSummarySchema>;

export const vehicleStatusSchema = z.object({
  vin: vinSchema,
  displayName: z.string().min(1),
  state: vehicleStateSchema,
  batteryLevel: z.number().min(0).max(100).nullable(),
  estimatedRangeKm: z.number().nonnegative().nullable(),
  chargingState: z.string().nullable(),
  chargeLimitPercent: z.number().min(0).max(100).nullable(),
  locked: z.boolean().nullable(),
  cabinTempC: z.number().nullable(),
  climateOn: z.boolean().nullable(),
  sentryMode: z.boolean().nullable(),
  observedAt: z.string().datetime(),
});

export type VehicleStatus = z.infer<typeof vehicleStatusSchema>;

export function normalizeVehicleState(value: string | undefined): VehicleState {
  const parsed = vehicleStateSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}
