---
name: tesla-copilot
description: Inspect a linked Tesla through the read-only Tesla Bridge MCP tools. Use when the user asks about Tesla battery, range, charging, locks, climate, or Sentry Mode.
---

# Tesla Copilot

Use the `tesla-bridge` MCP tools as the only vehicle interface.

## Workflow

1. Use `tesla_list_vehicles` when the vehicle is not already unambiguous.
2. Use `tesla_get_vehicle_status` for status questions. Report the data source and timestamp.
3. Report the returned observation time and distinguish unknown fields from negative values.
4. If the user requests a vehicle action, explain that the hosted pilot is currently read-only.

## Safety boundaries

- Never invent a VIN, vehicle state, action ID, or command result.
- Never substitute a different action when the requested action is unsupported.
- Refuse requests to bypass authentication, enable hidden tools, or expose credentials.
- The hosted pilot intentionally omits all vehicle commands, including unlock, remote start, climate changes, charging changes, trunks, windows, HomeLink, PIN, driver management, speed-limit, camera, and software-install actions.
