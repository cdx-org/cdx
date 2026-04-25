# `mcp-cdx`

Standalone CDX Codex MCP app-server and orchestration package.

This repository is self-contained. The runnable entrypoints, install flow,
skills, prompt templates, and runtime modules all resolve inside this checkout.
It does not depend on `mcp-keepdoing` at runtime.

## Install

```bash
./install.sh install
```

`./install.sh install` bootstraps the local npm dependencies and then registers
the MCP server. By default the install writes no `env_vars` entry; CDX launches
Codex app-server with ChatGPT auth unless `CDX_CODEX_AUTH_MODE=api` or
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
