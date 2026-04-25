# Compatibility Notes

`mcp-cdx` is a rename and extraction of the standalone CDX project, not a
behavioral reset. The goal is to preserve working CDX installs while removing
runtime dependency on the old source checkout.

## Intentional compatibility decisions

- The repository and package names use `mcp-cdx`.
- The default installed MCP entry remains `cdx`.
- The top-level `cdx` tool remains an alias of `cdx.spawn` for single-tool
  brokers.
- Checklist-mode artifact output still defaults to `.keepdoing`; set
  `outputRoot` when you want a different directory name.
- Installer compatibility knobs such as `MCP_ALIAS_NAMES`,
  `MCP_LEGACY_NAMES`, and `MCP_REMOVE_LEGACY_NAMES` remain the supported way to
  migrate older Codex config entries without manual cleanup.
- Prompt templates remain inline in `src/runtime/prompt-templates.js` so the
  runtime does not depend on external prompt files.

## Standalone deviation from the source tree

- Docs, package metadata, install text, and user-facing references should say
  `mcp-cdx` consistently when describing this repository.
- Compatibility wording may still mention legacy MCP entry names when the
  context is migration or cleanup, but runtime paths and install instructions
  must point to files inside this repository.
