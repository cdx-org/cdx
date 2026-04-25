#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"

NODE_BIN="${INSTALL_NODE_BIN:-node}"
NPM_BIN="${INSTALL_NPM_BIN:-npm}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
INSTALL_NPM_COMMAND="${INSTALL_NPM_COMMAND:-install}"
INSTALL_NPM_EXTRA_ARGS="${INSTALL_NPM_EXTRA_ARGS:---no-fund --no-audit}"
INSTALLER="$PROJECT_DIR/src/install/cli.js"
COMMAND="${1:-help}"

run_dependency_install() {
  if [[ "$INSTALL_DEPS" == "0" ]]; then
    return
  fi

  if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
    echo "install.sh: package.json not found under PROJECT_DIR=$PROJECT_DIR" >&2
    exit 1
  fi

  local -a extra_args=()
  if [[ -n "$INSTALL_NPM_EXTRA_ARGS" ]]; then
    # shellcheck disable=SC2206
    extra_args=($INSTALL_NPM_EXTRA_ARGS)
  fi

  echo "install.sh: installing npm dependencies in $PROJECT_DIR" >&2
  (
    cd "$PROJECT_DIR"
    "$NPM_BIN" "$INSTALL_NPM_COMMAND" "${extra_args[@]}"
  )
}

if [[ "$COMMAND" == "install" ]]; then
  run_dependency_install
fi

exec "$NODE_BIN" "$INSTALLER" "$@"
