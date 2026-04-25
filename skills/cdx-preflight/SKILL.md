---
name: cdx-preflight
description: Preflight checks and fixes so `cdx` can run in git repos (ensure git, repo, commits, clean state; optional auto-commit).
---

# cdx Preflight (Git)

## Overview

Make `cdx` runs resilient to git-related blockers by ensuring:

- git is installed
- target path is a non-bare repo
- `HEAD` exists (at least one commit)
- no merge/rebase/cherry-pick/revert in progress
- working tree is clean or auto-committed

Auto-commit creates a real commit of all local changes (including untracked files; excluding ignored files) before the orchestrator creates worktrees.

## Preflight: verify git + repo

```bash
command -v git
git -C <repo> rev-parse --is-inside-work-tree
git -C <repo> rev-parse --is-bare-repository
```

If the repo check fails, bootstrap the repo:

```bash
git -C <repo> init
git -C <repo> add -A
git -C <repo> -c user.name="Codex" -c user.email="codex@local" -c commit.gpgsign=false \
  commit --allow-empty -m "init: bootstrap repo for cdx"
```

## Preflight: ensure HEAD exists

```bash
git -C <repo> rev-parse --verify HEAD
```

If it fails, run the init + commit block above.

## Preflight: no in-progress operations

If any of these exist: `.git/MERGE_HEAD`, `.git/rebase-apply`, `.git/rebase-merge`, `.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`, finish or abort first:

```bash
git -C <repo> merge --abort
git -C <repo> rebase --abort
git -C <repo> cherry-pick --abort
git -C <repo> revert --abort
```

## Preflight: dirty working tree

Preferred: enable auto-commit for the MCP server so `cdx` can proceed even when dirty.

## Quick Start (persistent)

Configure the installed `cdx` MCP server to always run with `CDX_DIRTY_WORKTREE=commit`.

From the repo root:

```bash
MCP_ENV_JSON='{"CDX_DIRTY_WORKTREE":"commit"}' ./install.sh install
```

Optionally set a custom commit message:

```bash
MCP_ENV_JSON='{"CDX_DIRTY_WORKTREE":"commit","CDX_DIRTY_WORKTREE_COMMIT_MESSAGE":"WIP: before cdx"}' ./install.sh install
```

Restart Codex (or restart the MCP server) so the new env takes effect.

## Quick Start (one-off)

Run the `cdx` MCP server manually with auto-commit enabled:

```bash
CDX_DIRTY_WORKTREE=commit npm run start:cdx-appserver
```

## Verify

Confirm the server config includes the env entry (typical location):

- `~/.codex/config.toml` contains `[mcp_servers.cdx]`
- Under that section: `env = { CDX_DIRTY_WORKTREE = "commit", ... }`

## Safety Notes

- Auto-commit creates a real git commit on the current branch. Use only if that is acceptable for the workflow.
- Auto-init creates a `.git` directory and a real commit in the target path. Only use if that is acceptable.
- If you prefer not to create commits automatically, keep `CDX_DIRTY_WORKTREE` unset and use `git stash -u` or a manual WIP commit before calling `cdx`.

## Troubleshooting

- `cdx must run inside a git repository`: run the repo bootstrap steps above.
- `fatal: bad revision 'HEAD'` or `unknown revision`: create the initial commit.
- `Working tree is not clean`: enable auto-commit or stash/commit manually.
- `rebase/merge/cherry-pick in progress`: finish or abort those operations.
- If `cdx` still errors, the MCP server process is probably already running without the env; restart the server (or restart Codex) after updating config.
