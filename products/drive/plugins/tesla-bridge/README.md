# Tesla Bridge Codex plugin

Tesla Bridge packages the Bent Drive Copilot instructions and its hosted MCP connection for Codex. It connects to:

```text
https://drive.bent.build/mcp
```

The hosted release is read-only. After authenticating, it provides:

- `tesla_list_vehicles`
- `tesla_get_vehicle_status`

The status tool returns battery, estimated range, charging, lock, cabin climate, and Sentry state. No vehicle-changing command is registered or advertised.

## What an installer receives

The plugin is distributable independently from the web application. Its important packaging files are:

```text
.codex-plugin/plugin.json     Plugin metadata and skill/MCP declarations
.mcp.json                     Remote OAuth-protected MCP endpoint
skills/tesla-copilot/         Safe tool-use instructions for Codex
```

Installing the plugin does not deploy the Next.js application and does not require the user to receive or run its source. The centrally hosted service performs OAuth and Fleet API access; each user authorizes their own Tesla account.

The legacy `src`, `dist`, and package scripts in this directory are retained only for local prototype/server development. They are not started by the current plugin manifest, whose `.mcp.json` uses the remote HTTP service.

## Authentication flow

The plugin declares the MCP resource as `https://drive.bent.build/mcp`. Codex discovers the protected-resource metadata, dynamically registers as a public OAuth client, and uses authorization code with S256 PKCE. The user signs in and consents on Tesla's site. Tesla credentials and tokens are handled server-side and are never exposed to the model or stored by this plugin package.

The public MCP scope is `tesla.read`. The upstream Tesla scopes are `openid offline_access vehicle_device_data`. Requests for vehicle actions should be answered by explaining that the hosted pilot is currently read-only.

## Repository marketplace

This monorepo's marketplace entry is:

```text
.agents/plugins/marketplace.json
```

It points to `./plugins/tesla-bridge`, relative to the repository root. Add the repository marketplace in Codex, install `tesla-bridge`, and open a new task so the updated MCP and skill configuration are loaded.

Try:

```text
Use $tesla-copilot to check my Tesla's status.
```

Codex should request authentication when no valid MCP session exists, then return only data associated with the Tesla account connected during that flow.

## Validation

From the repository root on the current Codex development machine:

```bash
uv run --with pyyaml \
  python "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" \
  plugins/tesla-bridge
```

On another machine, use the validator shipped with that installation's plugin-creator skill.

The web service is developed and deployed from `apps/web` in the same Git repository. See the root [`README.md`](../../README.md) and [`DEPLOYMENT.md`](../../DEPLOYMENT.md). Code deployments are made only by the GitHub-connected Vercel project; plugin installation does not trigger a deployment.
