# `mcp-cdx`

Standalone CDX Codex MCP app-server and orchestration package.

This repository is self-contained. The runnable entrypoints, install flow,
skills, prompt templates, and runtime modules all resolve inside this checkout.
It does not depend on `mcp-keepdoing` at runtime.

## Install

Install directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/cdx-org/cdx/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/cdx-org/cdx/main/install.ps1 | iex
```

Or install from a local checkout:

```bash
./install.sh install
```

```powershell
.\install.ps1 install
```

The install wrappers bootstrap npm dependencies and then register the MCP
server. Remote installs clone or update the repo under the user data directory
by default; set `CDX_INSTALL_DIR` to choose another checkout/cache directory.
Existing streamed checkouts with local edits are left untouched during update,
and both wrappers default to `install` when no command is provided.
By default the install writes no `env_vars` entry; CDX launches Codex app-server
with ChatGPT auth unless `CDX_CODEX_AUTH_MODE=api` or
`CDX_CODEX_AUTH_MODE=inherit` is set.

The default installed MCP server name remains `cdx` for compatibility. The
default app-server entrypoint is
`src/cli/cdx-appserver-mcp-server.js`.

## Layout

- `src/cli/`: runnable Node entrypoints
- `src/runtime/`: shared runtime modules
- `src/install/`: install helpers behind `install.sh`
- `skills/`: shipped Codex skills
- `scripts/`: smoke and verification helpers
- `tests/`: automated verification

## Verify

```bash
npm run lint
npm test
```

For more detail, see:

- `docs/standalone-usage.md`
- `docs/install-metadata.md`
- `docs/repository-layout.md`
- `docs/compatibility.md`
