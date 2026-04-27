# Repository Layout

`mcp-cdx` keeps the CDX runtime self-contained under `src/`. The installed MCP
server, shipped skills, prompt templates, and install flow must resolve within
this repository instead of depending on an external source tree.

## Active Directories

- `src/cli/`
  Runnable Node entrypoints. The default standalone install target is
  `src/cli/cdx-appserver-mcp-server.js`.
- `src/runtime/`
  Shared runtime modules and assets used by the CLI entrypoints.
- `src/install/`
  Install-time helpers behind `./install.sh` and `.\install.ps1`.
- `src/skills/`
  Skill metadata and validation helpers for the shipped standalone payload.
- `skills/`
  Installable Codex skills copied by the install wrappers when present. The
  current shipped set is `cdx-preflight` and `cdx-wait-controller`.
- `tests/skills/`
  Focused standalone payload checks that ensure the shipped skills remain
  self-contained.
- `docs/`
  Operator and maintainer documentation for standalone `mcp-cdx`.
- `tests/`
  Automated tests, smoke helpers, fixtures, and documentation checks.

## Prompt Templates

Runtime prompt templates remain inline-only in
`src/runtime/prompt-templates.js`.

Standalone packaging must preserve those inline templates locally in this repo
instead of loading prompt files from another checkout. The loader requires
callers to provide live fallback text at the call site.

Automated checks enforce the same rule:

- No separate runtime prompt-file inventory.
- No test-only prompt fixture directory.
- No smoke helpers that depend on prompt-template files.

## Install Target

`./install.sh install` and `.\install.ps1 install` bootstrap local npm
dependencies, register the default `cdx` MCP server, and point it at
`src/cli/cdx-appserver-mcp-server.js`. When run through
`curl -fsSL ... | bash` or `irm ... | iex`, the wrappers first clone or update
this repository in the user data directory.

Compatibility aliases and legacy-entry cleanup remain install-time migration
helpers. The standalone package and repository names are `mcp-cdx`.

## Canonical Source Layout

Standalone `mcp-cdx` keeps one canonical implementation tree:

- runnable entrypoints live under `src/cli/`
- shared modules live under `src/runtime/`

Do not reintroduce parallel compatibility copies such as `src/app/`,
`src/apps/`, or `src/lib/`. Standalone packaging should stay readable and
maintainable without duplicate source trees.
