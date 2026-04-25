---
name: cdx-wait-controller
description: Launch a CDX run with a single `cdx` MCP call, hand work off to CDX, and return control to the user without polling. Use when the user wants to start a CDX run, hand work off, continue in the background, or keep this chat free while CDX runs. Monitor with `cdx.status` or `cdx.ps` only when the user explicitly asks.
---

# CDX Handoff Controller

## Default workflow

- Use the public `cdx` entrypoint when it is available.
- Call `cdx` exactly once with the user's goal and any explicit `repoRoot`, `parallelism`, `range`, or `maxParallelism` inputs.
- Treat an immediate handoff response as success when CDX reports a running, background, reused, or deduped run.
- After the launch call returns, stop. Do not start a `cdx.status` polling loop. Do not call `cdx.logs`, `cdx.pending_asks`, `cdx.router_answer`, `cdx.steer`, or any abort tool unless the user explicitly asks to supervise, inspect, or stop the run.
- Do not restart the same run unless the user explicitly asks.

## Repo preparation

- Rely on CDX's built-in git preflight by default.
- Use the `cdx-preflight` skill only when the user is trying to fix git blockers or the `cdx` call fails with a repo/preflight error.

## When CDX does not hand off cleanly

- If `cdx` returns clarification questions, missing required fields, or a blocking supervisor prompt instead of a running run, surface that result to the user and wait for instructions.
- Do not enter a monitoring loop while waiting for clarification.

## Report back after launch

- `runId`, if present
- `status`, if present
- `statsUrl`, if present
- A short note that CDX now owns execution and this chat is no longer monitoring the run

## Only monitor when asked

- If the user later asks to check progress, use `cdx.status`.
- If the user later asks to list active runs, use `cdx.ps`.
- If the user later asks to inspect logs or supervise the run, use the relevant helper tools only for that explicit request.
