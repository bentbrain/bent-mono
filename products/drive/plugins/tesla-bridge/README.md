# Tesla Bridge Codex plugin

Tesla Bridge packages the Bent Drive Copilot skill instructions, plugin manifest, remote MCP metadata and local stdio/HTTP server tooling.

The Drive MCP service is read-only. After authenticating, it provides:

- `tesla_list_vehicles`
- `tesla_get_vehicle_status`

The status tool reads battery, estimated range, charging, lock, cabin climate, and Sentry state.

The hosted endpoint (`https://drive.bent.build/mcp`) supports ChatGPT custom MCP connectors; see [drive.bent.build/docs](https://drive.bent.build/docs). Under Drive's default production settings (`ALLOW_LOCAL_OAUTH_REDIRECTS=false`), OAuth dynamic client registration rejects loopback callbacks (such as Codex CLI's default local callback) with `invalid_redirect_uri`, so Codex CLI usage requires a local development instance of `products/drive/apps/web` with `ALLOW_LOCAL_OAUTH_REDIRECTS=true`.

## Package contents

The plugin package is structured independently from the web application. Its packaging files are:

```text
.codex-plugin/plugin.json     Plugin metadata and skill/MCP declarations
.mcp.json                     Remote OAuth-protected MCP endpoint metadata (https://drive.bent.build/mcp)
skills/tesla-copilot/         Safe tool-use instructions for Codex
```

The Next.js web application in `products/drive/apps/web` handles OAuth and Tesla Fleet API access, and asks each user to authorize their own Tesla account.

Use `src`, `dist`, and the package scripts in this directory for local prototype/server development.

## Authentication flow

`.mcp.json` declares the hosted MCP resource as `https://drive.bent.build/mcp`. An OAuth MCP client discovers the protected-resource metadata, dynamically registers as a public OAuth client, and uses authorization code with S256 PKCE. The user signs in with an invited GitHub account and consents on Tesla's site. Tesla credentials and tokens are handled server-side and are never exposed to the model or stored by this plugin package.

Dynamic client registration on the hosted service allows ChatGPT connector callbacks only. Loopback callbacks for local clients such as Codex CLI require a development instance configured with `ALLOW_LOCAL_OAUTH_REDIRECTS=true`.

The public MCP scope is `tesla.read`. The upstream Tesla scopes are `openid offline_access vehicle_device_data`. For vehicle-action requests, explain that this connection supports reading vehicle data only.

## Connecting

For the hosted service at `https://drive.bent.build/mcp`, connect through ChatGPT by following [drive.bent.build/docs](https://drive.bent.build/docs).

In this monorepo, the plugin package lives at `products/drive/plugins/tesla-bridge` (no root Codex marketplace manifest is bundled here). To test with Codex CLI against a local development instance of `products/drive/apps/web` that has `ALLOW_LOCAL_OAUTH_REDIRECTS=true`:

1. Register your local MCP endpoint in Codex:

```bash
codex mcp add tesla-bridge --url http://localhost:3000/mcp
```

2. Optionally copy or symlink `products/drive/plugins/tesla-bridge/skills/tesla-copilot` into your Codex skills directory (`~/.codex/skills/tesla-copilot`) and open a new task so `$tesla-copilot` is available.

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
