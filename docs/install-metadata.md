# Install Metadata

This standalone repository is packaged as `mcp-cdx`, but the installer still
registers the default MCP server as `cdx`.

That split is intentional:

- `mcp-cdx` is the repository and package identity used by `package.json` and
  the lockfile.
- `cdx` remains the default `[mcp_servers.<name>]` entry because the current
  runtime behavior, app-server help text, and Codex workflows already use that
  server name.

## Installer Defaults

- Installer entrypoint: `src/install/cli.js`
- Default runtime entry: `src/cli/cdx-appserver-mcp-server.js`
- Default config target: `~/.codex/config.toml`
- Default copied skills source: `PROJECT_DIR/skills`
- Default copied skills destination: `~/.codex/skills`

## Compatibility

- `MCP_NAME` can override the registered server name.
- `MCP_ALIAS_NAMES` can register additional aliases alongside the primary name.
- Install runs remove legacy MCP sections named `keepdoing`,
  `codex-as-service`, and `codex_as_service` unless
  `MCP_REMOVE_LEGACY_NAMES=0` is set.

## Config Assets

No static `config/` payload is required for install metadata. The installer
generates or updates the Codex config file in place, which keeps the standalone
repo self-contained without shipping a second config source of truth.

## Verification

Run the standalone install/runtime audit from the repo root:

```bash
node scripts/verify-standalone-self-containment.mjs
node --test tests/scripts/self-contained.test.js
```
