# CLI Help Notes

User-facing help emitted by standalone CLI entrypoints should describe this
repository and package as `mcp-cdx` consistently.

Keep the following compatibility behaviors visible in CLI help where relevant:

- The default installed MCP entry name remains `cdx`.
- The top-level `cdx` tool remains an alias of `cdx.spawn`.
- Checklist artifacts still default to `.keepdoing` unless `outputRoot` is
  overridden.

Prefer `checklist mode` over legacy wording when describing workflow options in
help text.
