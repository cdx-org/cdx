# Orchestrator Eval Harness

`mcp-cdx` now ships a local side-by-side eval harness for comparing the same
task corpus against:

- `cdx` via the standalone MCP app-server in this repo
- `claude-code-main` via headless `--print --output-format stream-json`

The goal is practical regression tracking, not abstract scoring. Each case runs
in an isolated workspace, emits raw artifacts, and can optionally run a verifier
command against the post-run workspace.

## Run

```bash
node scripts/eval-orchestrators.js
node scripts/eval-orchestrators.js --case=smoke-file-write --verbose
node scripts/eval-orchestrators.js --adapter=cdx --results-dir=./eval/results-local
node scripts/eval-orchestrators.js --corpus=./eval/cases/real-smoke.json --adapter=cdx
node scripts/eval-orchestrators.js --corpus=./eval/cases/real-smoke-local.json --adapter=cdx,claude --verbose
```

Default corpus:

```text
eval/cases/sample.json
```

Default results root:

```text
eval/results/<timestamp>/
```

Each adapter writes its own artifacts under:

```text
eval/results/<timestamp>/<case-id>/<adapter>/
```

## Corpus Format

Top-level shape:

```json
{
  "defaults": {
    "workspaceMode": "copy",
    "timeoutMs": 300000,
    "maxTurns": 20,
    "adapterConfig": {
      "cdx": {
        "spawnArgs": {
          "minParallelism": 4,
          "maxParallelism": 8
        }
      },
      "claude": {
        "coordinatorMode": true
      }
    }
  },
  "cases": [
    {
      "id": "fix-tests",
      "repoRoot": "../../some-repo",
      "prompt": "Fix the failing test suite and explain the root cause.",
      "workspaceMode": "copy",
      "timeoutMs": 900000,
      "maxTurns": 50,
      "verification": {
        "commands": [
          "npm test -- --runInBand"
        ]
      },
      "success": {
        "outputIncludes": ["root cause"],
        "adapters": {
          "cdx": {
            "statuses": ["completed"]
          },
          "claude": {
            "subtypes": ["success"],
            "minTaskNotifications": 1
          }
        }
      }
    }
  ]
}
```

Supported fields per case:

- `id`: stable case id.
- `repoRoot`: repo or workspace seed root. Relative paths resolve from the
  corpus file directory.
- `prompt`: prompt sent to both orchestrators.
- `workspaceMode`: `copy`, `git-worktree`, or `in-place`.
- `workspaceIgnore`: extra relative paths to skip in `copy` mode.
- `timeoutMs`: wall clock timeout per adapter run.
- `maxTurns`: Claude max turns.
- `adapterConfig.cdx.spawnArgs`: extra `cdx.spawn` arguments.
- `adapterConfig.cdx.env`: extra env vars for the cdx adapter.
- `adapterConfig.claude`: command/env/args and coordinator-mode overrides.
- `adapterConfig.claude.mockServer`: when set, starts a local Anthropic-compatible
  sidecar for deterministic Claude smoke runs.
- `verification`: shell command or command list run after the adapter finishes.
- `success`: simple heuristics for status/subtype and output substring checks.

## Adapter Notes

### `cdx`

- Uses the standalone app-server directly.
- Forces `CDX_BACKGROUND_BACKEND_ENABLED=0` during eval so the harness can own
  process cleanup and avoid detached orphan runs.
- Starts runs through `cdx.spawn`, then polls `cdx.status` with event streaming.

Artifacts:

- `spawn-result.json`
- `status-snapshots.json`
- `events.json`
- `final-status.json`
- `verification.json` when a verifier is configured

### `claude`

- Uses headless print mode with `--output-format stream-json`.
- Defaults to `CLAUDE_CODE_COORDINATOR_MODE=1`.
- Defaults to `--dangerously-skip-permissions --permission-mode bypassPermissions`.
- If no explicit Claude command is configured, the harness looks for `bun` on
  `PATH`, then falls back to `~/.bun/bin/bun`.
- By default the harness prefers `claude-code-main/dist/cli.js`; if `dist/`
  does not exist, it falls back to `src/entrypoints/cli.tsx`.
- `adapterConfig.claude.mockServer` starts `tools/scripts/mock-anthropic-server.js`
  and injects `ANTHROPIC_BASE_URL` plus a dummy API key automatically.

Artifacts:

- `stream.jsonl`
- `stderr.txt`
- `mock-server.stdout.log`, `mock-server.stderr.log`, and
  `mock-server.requests.jsonl` when `mockServer` is enabled
- `verification.json` when a verifier is configured

If `bun` is not installed and no explicit Claude command is provided, the
Claude adapter is reported as `skipped` instead of crashing the entire run.

## Real Smoke Corpora

- `eval/cases/real-smoke.json`: live file-write corpus. `cdx` can run to
  completion locally; Claude uses the real Anthropic backend and currently
  depends on external account/billing state.
- `eval/cases/real-smoke-local.json`: same file-write corpus, but Claude is
  routed through the local mock Anthropic sidecar so both orchestrators can be
  exercised end-to-end in CI or local smoke runs.

## CLI Overrides

```bash
node scripts/eval-orchestrators.js \
  --corpus=./my-corpus.json \
  --adapter=cdx,claude \
  --claude-repo-root=../claude-code/claude-code-main \
  --claude-command=bun \
  --claude-args='["run","/abs/path/to/src/entrypoints/cli.tsx"]'
```

Environment variables are also supported:

- `CDX_EVAL_CDX_COMMAND`
- `CDX_EVAL_CDX_ARGS`
- `CDX_EVAL_CLAUDE_COMMAND`
- `CDX_EVAL_CLAUDE_ARGS`
- `CDX_EVAL_CLAUDE_REPO`
- `CDX_EVAL_TIMEOUT_MS`

## Interpretation

The generated `report.md` is meant for fast comparison:

- `status`: harness-level outcome (`completed`, `failed`, `timed_out`,
  `needs_input`, `skipped`)
- `success`: whether the adapter met the configured success heuristics
- `signal`: orchestration evidence summary
  - `cdx`: tasks/events/pending asks
  - `claude`: worker notifications/turns

For code-changing workloads, the verifier command is the most important signal.
