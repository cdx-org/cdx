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
- Shell wrapper: `install.sh`
- PowerShell wrapper: `install.ps1`
- Default runtime entry: `src/cli/cdx-appserver-mcp-server.js`
- Default config target: `~/.codex/config.toml`
- Default copied skills source: `PROJECT_DIR/skills`
- Default copied skills destination: `~/.codex/skills`
- Default remote install repo: `https://github.com/cdx-org/cdx.git`
- Default remote install ref: `main`
- Default remote install directory: `~/.local/share/mcp-cdx` on Unix-like
  systems and `%LOCALAPPDATA%\mcp-cdx` on Windows.

## Remote Install

Use the raw GitHub wrappers for one-command installs:

```bash
curl -fsSL https://raw.githubusercontent.com/cdx-org/cdx/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/cdx-org/cdx/main/install.ps1 | iex
```

When run from a pipe, the wrappers clone or update the repo in the remote
install directory, install npm dependencies, and then invoke `src/install/cli.js`
with `install`. Existing streamed checkouts are updated only when their git
worktree is clean; dirty checkouts are left untouched so local edits are not
lost. Set `CDX_INSTALL_SKIP_UPDATE=1` to disable update attempts entirely.

The wrappers also default to `install` when no command is provided and perform a
Node.js/npm preflight before dependency installation. Override the runtime with
`INSTALL_NODE_BIN` and `INSTALL_NPM_BIN`, or set `SKIP_NODE_CHECK=1` to bypass
the preflight.

## Compatibility

- `MCP_NAME` can override the registered server name.
- `MCP_ALIAS_NAMES` can register additional aliases alongside the primary name.
- Install runs remove legacy MCP sections named `keepdoing`,
  `codex-as-service`, and `codex_as_service` unless
  `MCP_REMOVE_LEGACY_NAMES=0` is set.
- `backup` and `restore [latest|path]` are available for explicit config
  recovery in addition to the automatic pre-install backup.

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
