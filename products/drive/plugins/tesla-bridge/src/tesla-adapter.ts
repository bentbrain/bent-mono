import { z } from "zod";

import {
  actionResultSchema,
  normalizeVehicleState,
  vehicleStatusSchema,
  vehicleSummarySchema,
} from "./domain.js";
import { TeslaTokenStore } from "./token-store.js";

import type { TeslaBridgeConfig } from "./config.js";
import type { ActionResult, VehicleAction, VehicleStatus, VehicleSummary } from "./domain.js";

export interface TeslaAdapter {
  listVehicles(): Promise<VehicleSummary[]>;
  getVehicleStatus(vin: string): Promise<VehicleStatus>;
  executeAction(vin: string, action: VehicleAction): Promise<ActionResult>;
}

const mockVin = "MOCKVIN0000000001";

export class MockTeslaAdapter implements TeslaAdapter {
  #status: VehicleStatus = vehicleStatusSchema.parse({
    vin: mockVin,
    displayName: "Nova",
    state: "online",
    batteryLevel: 72,
    estimatedRangeKm: 348,
    chargingState: "Disconnected",
    chargeLimitPercent: 80,
    locked: true,
    cabinTempC: 27.5,
    climateOn: false,
    sentryMode: true,
    observedAt: new Date().toISOString(),
    dataSource: "mock",
  });

  async listVehicles(): Promise<VehicleSummary[]> {
    return [
      vehicleSummarySchema.parse({
        vin: this.#status.vin,
        displayName: this.#status.displayName,
        state: this.#status.state,
      }),
    ];
  }

  async getVehicleStatus(vin: string): Promise<VehicleStatus> {
    this.#requireVehicle(vin);
    this.#status = vehicleStatusSchema.parse({
      ...this.#status,
      observedAt: new Date().toISOString(),
    });
    return this.#status;
  }

  async executeAction(vin: string, action: VehicleAction): Promise<ActionResult> {
    this.#requireVehicle(vin);

    switch (action.type) {
      case "lock":
        this.#status = { ...this.#status, locked: true };
        break;
      case "start_climate":
        this.#status = { ...this.#status, climateOn: true };
        break;
      case "stop_climate":
        this.#status = { ...this.#status, climateOn: false };
        break;
      case "set_charge_limit":
        this.#status = { ...this.#status, chargeLimitPercent: action.percent };
        break;
      case "start_charging":
        this.#status = { ...this.#status, chargingState: "Charging" };
        break;
      case "stop_charging":
        this.#status = { ...this.#status, chargingState: "Stopped" };
        break;
      case "enable_sentry":
        this.#status = { ...this.#status, sentryMode: true };
        break;
      case "disable_sentry":
        this.#status = { ...this.#status, sentryMode: false };
        break;
    }

    this.#status = vehicleStatusSchema.parse({
      ...this.#status,
      observedAt: new Date().toISOString(),
    });

    return actionResultSchema.parse({
      succeeded: true,
      message: `Mock vehicle accepted ${action.type}.`,
      completedAt: new Date().toISOString(),
      dataSource: "mock",
    });
  }

  #requireVehicle(vin: string): void {
    if (vin !== this.#status.vin) {
      throw new Error(`Vehicle ${vin} was not found.`);
    }
  }
}

const fleetVehiclesResponseSchema = z.object({
  response: z.array(
    z.object({
      vin: z.string(),
      display_name: z.string().nullable().optional(),
      state: z.string().optional(),
    })
  ),
});

const fleetVehicleDataResponseSchema = z.object({
  response: z.object({
    vin: z.string(),
    display_name: z.string().nullable().optional(),
    state: z.string().optional(),
    charge_state: z
      .object({
        battery_level: z.number().optional(),
        battery_range: z.number().optional(),
        charging_state: z.string().optional(),
        charge_limit_soc: z.number().optional(),
      })
      .optional(),
    climate_state: z
      .object({
        inside_temp: z.number().optional(),
        is_climate_on: z.boolean().optional(),
      })
      .optional(),
    vehicle_state: z
      .object({
        locked: z.boolean().optional(),
        sentry_mode: z.boolean().optional(),
      })
      .optional(),
  }),
});

const fleetCommandResponseSchema = z.object({
  response: z.object({
    result: z.boolean(),
    reason: z.string().optional(),
  }),
});

type CommandRequest = {
  command: string;
  body: Record<string, number | boolean>;
};

class FleetApiTeslaAdapter implements TeslaAdapter {
  readonly #accessToken: string | undefined;
  readonly #clientId: string | undefined;
  readonly #tokenStore: TeslaTokenStore | undefined;
  readonly #fleetApiBaseUrl: string;
  readonly #commandProxyUrl: string | undefined;

  constructor(config: TeslaBridgeConfig) {
    if (!config.accessToken && !config.clientId) {
      throw new Error("TESLA_CLIENT_ID or TESLA_ACCESS_TOKEN is required in live mode.");
    }
    this.#accessToken = config.accessToken;
    this.#clientId = config.clientId;
    this.#tokenStore = config.accessToken
      ? undefined
      : new TeslaTokenStore(config.tokenFile, config.tokenEndpoint);
    this.#fleetApiBaseUrl = config.fleetApiBaseUrl;
    this.#commandProxyUrl = config.commandProxyUrl;
  }

  async listVehicles(): Promise<VehicleSummary[]> {
    const body = await this.#request(this.#fleetApiBaseUrl, "/api/1/vehicles", { method: "GET" });
    const parsed = fleetVehiclesResponseSchema.parse(body);
    return parsed.response.map((vehicle) =>
      vehicleSummarySchema.parse({
        vin: vehicle.vin,
        displayName: vehicle.display_name ?? vehicle.vin,
        state: normalizeVehicleState(vehicle.state),
      })
    );
  }

  async getVehicleStatus(vin: string): Promise<VehicleStatus> {
    const body = await this.#request(
      this.#fleetApiBaseUrl,
      `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`,
      { method: "GET" }
    );
    const parsed = fleetVehicleDataResponseSchema.parse(body).response;
    return vehicleStatusSchema.parse({
      vin: parsed.vin,
      displayName: parsed.display_name ?? parsed.vin,
      state: normalizeVehicleState(parsed.state),
      batteryLevel: parsed.charge_state?.battery_level ?? null,
      estimatedRangeKm:
        parsed.charge_state?.battery_range === undefined
          ? null
          : Math.round(parsed.charge_state.battery_range * 1.60934),
      chargingState: parsed.charge_state?.charging_state ?? null,
      chargeLimitPercent: parsed.charge_state?.charge_limit_soc ?? null,
      locked: parsed.vehicle_state?.locked ?? null,
      cabinTempC: parsed.climate_state?.inside_temp ?? null,
      climateOn: parsed.climate_state?.is_climate_on ?? null,
      sentryMode: parsed.vehicle_state?.sentry_mode ?? null,
      observedAt: new Date().toISOString(),
      dataSource: "fleet-api",
    });
  }

  async executeAction(vin: string, action: VehicleAction): Promise<ActionResult> {
    if (!this.#commandProxyUrl) {
      throw new Error("TESLA_COMMAND_PROXY_URL is required for signed live vehicle commands.");
    }
    const request = commandRequest(action);
    const body = await this.#request(
      this.#commandProxyUrl,
      `/api/1/vehicles/${encodeURIComponent(vin)}/command/${request.command}`,
      {
        method: "POST",
        body: JSON.stringify(request.body),
      }
    );
    const response = fleetCommandResponseSchema.parse(body).response;
    return actionResultSchema.parse({
      succeeded: response.result,
      message: response.result ? `${action.type} completed.` : response.reason ?? `${action.type} failed.`,
      completedAt: new Date().toISOString(),
      dataSource: "fleet-api",
    });
  }

  async #request(baseUrl: string, path: string, init: RequestInit): Promise<unknown> {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const url = new URL(path.replace(/^\//, ""), base);
    let response = await this.#send(url, init, await this.#getAccessToken());
    if (response.status === 401 && this.#tokenStore && this.#clientId) {
      response = await this.#send(url, init, await this.#tokenStore.refresh(this.#clientId));
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Tesla request failed with HTTP ${response.status}.`);
    }
    return body;
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken) {
      return this.#accessToken;
    }
    if (!this.#tokenStore || !this.#clientId) {
      throw new Error("Tesla OAuth token storage is not configured.");
    }
    return this.#tokenStore.getAccessToken(this.#clientId);
  }

  async #send(url: URL, init: RequestInit, accessToken: string): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
    });
  }
}

export function createTeslaAdapter(config: TeslaBridgeConfig): TeslaAdapter {
  return config.mode === "mock" ? new MockTeslaAdapter() : new FleetApiTeslaAdapter(config);
}

function commandRequest(action: VehicleAction): CommandRequest {
  switch (action.type) {
    case "lock":
      return { command: "door_lock", body: {} };
    case "start_climate":
      return { command: "auto_conditioning_start", body: {} };
    case "stop_climate":
      return { command: "auto_conditioning_stop", body: {} };
    case "set_charge_limit":
      return { command: "set_charge_limit", body: { percent: action.percent } };
    case "start_charging":
      return { command: "charge_start", body: {} };
    case "stop_charging":
      return { command: "charge_stop", body: {} };
    case "enable_sentry":
      return { command: "set_sentry_mode", body: { on: true } };
    case "disable_sentry":
      return { command: "set_sentry_mode", body: { on: false } };
  }
}
