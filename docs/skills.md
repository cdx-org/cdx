# Shipped Skills

`mcp-cdx` ships repo-local Codex skills under `skills/`. The install flow is
expected to enumerate each top-level directory under `skills/` and copy it into
`~/.codex/skills` during `./install.sh install`.

## Current Set

- `cdx-preflight`
  Preflight checks and fixes for git repos before a CDX run.
- `cdx-wait-controller`
  One-shot launch guidance for handing work to CDX without entering a monitor loop.

## Standalone Rules

- Keep the repo-local payload under `skills/<name>/SKILL.md` so the installer can
  copy it without any extra manifest lookup.
- Keep `src/skills/manifest.mjs` aligned with the shipped directory names.
- Keep skill text free of source-repo and legacy-package references.

## Verification

Run the standalone payload audit from the repo root:

```bash
node scripts/verify-skills-payload.mjs
node --test tests/skills/payload.test.mjs
```
