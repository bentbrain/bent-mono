# Tesla Bridge Codex plugin

Tesla Bridge packages the Bent Drive Copilot instructions and its hosted MCP connection for Codex. It connects to:

```text
https://drive.bent.build/mcp
```

The hosted release is read-only. After authenticating, it provides:

- `tesla_list_vehicles`
- `tesla_get_vehicle_status`

The status tool reads battery, estimated range, charging, lock, cabin climate, and Sentry state.

## What an installer receives

The plugin is distributable independently from the web application. Its packaging files are:

```text
.codex-plugin/plugin.json     Plugin metadata and skill/MCP declarations
.mcp.json                     Remote OAuth-protected MCP endpoint
skills/tesla-copilot/         Safe tool-use instructions for Codex
```

Install the plugin to connect to the hosted service. The service runs the Next.js application, handles OAuth and Fleet API access, and asks each user to authorize their own Tesla account.

Use `src`, `dist`, and the package scripts in this directory for local prototype/server development. The plugin manifest connects to the remote HTTP service through `.mcp.json`.

## Authentication flow

The plugin declares the MCP resource as `https://drive.bent.build/mcp`. Codex discovers the protected-resource metadata, dynamically registers as a public OAuth client, and uses authorization code with S256 PKCE. The user signs in and consents on Tesla's site. Tesla credentials and tokens are handled server-side and are never exposed to the model or stored by this plugin package.

The public MCP scope is `tesla.read`. The upstream Tesla scopes are `openid offline_access vehicle_device_data`. For vehicle-action requests, explain that this connection supports reading vehicle data only.

## Installing in Codex

In this monorepo, the plugin package lives at `products/drive/plugins/tesla-bridge`. No root Codex marketplace manifest is bundled here; connect Codex directly to the hosted MCP endpoint (`https://drive.bent.build/mcp`) using `.mcp.json` and `skills/tesla-copilot/`, or point a local Codex plugin marketplace entry at `./products/drive/plugins/tesla-bridge`, install `tesla-bridge`, and open a new task so the MCP and skill configuration load.

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
  products/drive/plugins/tesla-bridge
```

On another machine, use the validator shipped with that installation's plugin-creator skill.

The web service is developed and deployed from `apps/web` in this product directory. See the [Drive README](../../README.md) and [`apps/web/README.md`](../../apps/web/README.md). Code deployments must use the GitHub-connected Vercel project through the repository's Vercel release workflow.
