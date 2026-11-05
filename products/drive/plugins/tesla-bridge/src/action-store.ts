import { randomUUID } from "node:crypto";

import type { VehicleAction } from "./domain.js";

export type PendingVehicleAction = {
  id: string;
  vin: string;
  action: VehicleAction;
  reason: string;
  preparedAt: string;
  expiresAt: string;
};

export class ActionStore {
  readonly #ttlMs: number;
  readonly #pending = new Map<string, PendingVehicleAction>();

  constructor(ttlMs = 2 * 60 * 1000) {
    this.#ttlMs = ttlMs;
  }

  prepare(vin: string, action: VehicleAction, reason: string, now = new Date()): PendingVehicleAction {
    this.prune(now);
    const pending = {
      id: randomUUID(),
      vin,
      action,
      reason,
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    this.#pending.set(pending.id, pending);
    return pending;
  }

  consume(id: string, now = new Date()): PendingVehicleAction {
    const pending = this.#pending.get(id);
    if (!pending) {
      throw new Error("The prepared action was not found or has already been used.");
    }

    this.#pending.delete(id);
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      throw new Error("The prepared action expired. Prepare it again before execution.");
    }
    return pending;
  }

  prune(now = new Date()): void {
    for (const [id, pending] of this.#pending) {
      if (Date.parse(pending.expiresAt) <= now.getTime()) {
        this.#pending.delete(id);
      }
    }
  }
}
