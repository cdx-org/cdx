# Runtime Prompt Templates

`mcp-cdx` keeps runtime prompt templates inline-only in
`src/runtime/prompt-templates.js`.

`loadPromptTemplate(name, fallback)` does not read prompt files from disk. It
returns the live inline fallback string supplied by the caller so prompt text
ships with the runtime code that uses it.

`renderPromptTemplate(template, vars)` performs the lightweight
`{{placeholder}}` interpolation used by the current CDX runtime.

Automated checks under `tests/runtime/` enforce two invariants:

- Every `loadPromptTemplate(...)` call site must pass an inline fallback argument.
- Prompt-related runtime code must not reference prompt directories or any external source tree.

Operational rules:

- Do not add a runtime `prompts/` directory for these templates.
- Do not add test-only prompt fixture directories under `test/prompts` or `tests/prompts`.
- Do not point prompt loading at any external source tree.
