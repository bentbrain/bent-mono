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

In this monorepo, the plugin package lives at `products/drive/plugins/tesla-bridge` (no root Codex marketplace manifest is bundled here). You can connect it in either of two ways:

1. **Via a local Codex marketplace:** point a local marketplace entry at `./products/drive/plugins/tesla-bridge`, install `tesla-bridge`, and start a new task so both the MCP server (`.mcp.json`) and the `$tesla-copilot` skill (`skills/tesla-copilot/`) load together.
2. **Direct MCP registration:** register the hosted endpoint directly in Codex MCP settings or via the CLI:

```bash
codex mcp add tesla-bridge --url https://drive.bent.build/mcp
```

If you also want to use the `$tesla-copilot` skill with direct MCP registration, copy or symlink `products/drive/plugins/tesla-bridge/skills/tesla-copilot` into your Codex skills directory (`~/.codex/skills/tesla-copilot`) and start a new task.

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
