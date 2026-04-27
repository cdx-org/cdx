# Standalone `mcp-cdx`

`mcp-cdx` is the standalone home for the CDX Codex app-server orchestrator.
It must install and run using files from this repository only, without any
runtime dependency on another checkout.

## Install

Install directly from GitHub and register the default `cdx` MCP entry:

```bash
curl -fsSL https://raw.githubusercontent.com/cdx-org/cdx/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/cdx-org/cdx/main/install.ps1 | iex
```

Remote installs clone or update the repo under the user data directory by
default. Set `CDX_INSTALL_DIR` to choose another checkout/cache directory.

From a local checkout, use the platform wrapper directly:

```bash
./install.sh install
```

```powershell
.\install.ps1 install
```

The install wrappers run `npm install --no-fund --no-audit` in the project root
before updating Codex config.

The default install target is the local
`src/cli/cdx-appserver-mcp-server.js` entrypoint. Use `./install.sh help` or
`.\install.ps1 help` to inspect installer overrides such as alternate entry
names, alias registration, environment injection, and legacy-entry cleanup.

Default installs do not write an `env_vars` pass-through list. CDX launches
Codex app-server using ChatGPT auth by default; set `CDX_CODEX_AUTH_MODE=api`
or `CDX_CODEX_AUTH_MODE=inherit` only when intentionally using another auth
mode.

## Main entrypoints

- `src/cli/cdx-appserver-mcp-server.js`
  Default app-server-backed MCP server for standalone CDX usage.
- `src/cli/cdx-mcp-server.js`
  Broker-mode MCP server entrypoint.
- `src/cli/server.js`
  Broker server entrypoint.
- `src/cli/orchestrator.js`
  Broker worker/orchestrator entrypoint.
- `src/cli/bridge.js`
  Broker bridge entrypoint.
- `src/cli/hook-llm-backend.js`
  Hook backend used for LLM-backed app-server flows.

## Core MCP tools

- `cdx.spawn`
  Preferred entrypoint for background orchestration with immediate control
  return.
- `cdx`
  Intentional compatibility alias of `cdx.spawn` for brokers that expose a
  single top-level tool.
- `cdx.run`
  Manual/blocking entrypoint when explicit orchestration control is needed.
- `cdx.status`
  Run, task, and event inspection.
- `cdx.ps`
  Running-run inventory.
- `cdx.help`
  Built-in usage/help summary for the CDX MCP surface.

## Shipped skills

When skill installation is enabled, the install wrappers copy the shipped repo
skills into `CODEX_HOME/skills`:

- `cdx-preflight`
- `cdx-wait-controller`

## Standalone expectations

- Package and repo naming should use `mcp-cdx`.
- The installed MCP server name remains `cdx` by default for compatibility.
- Runtime prompt templates stay inline in `src/runtime/prompt-templates.js`.
- Shared runtime modules stay under `src/runtime/`.
- Standalone packaging must not reach back into another checkout at runtime.
