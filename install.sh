#!/usr/bin/env bash
set -euo pipefail

DEFAULT_INSTALL_REPO="https://github.com/cdx-org/cdx.git"
DEFAULT_INSTALL_REF="main"

INSTALL_REPO="${CDX_INSTALL_REPO:-$DEFAULT_INSTALL_REPO}"
INSTALL_REF="${CDX_INSTALL_REF:-$DEFAULT_INSTALL_REF}"

is_project_dir() {
  local candidate="${1:-}"
  [[ -n "$candidate" ]] &&
    [[ -f "$candidate/package.json" ]] &&
    [[ -f "$candidate/src/install/cli.js" ]]
}

script_dir_from_source() {
  local source="${BASH_SOURCE[0]:-}"
  if [[ -n "$source" && -f "$source" ]]; then
    CDPATH= cd -- "$(dirname -- "$source")" && pwd
  fi
}

default_install_dir() {
  if [[ -n "${CDX_INSTALL_DIR:-}" ]]; then
    printf '%s\n' "$CDX_INSTALL_DIR"
  elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
    printf '%s\n' "$XDG_DATA_HOME/mcp-cdx"
  else
    printf '%s\n' "$HOME/.local/share/mcp-cdx"
  fi
}

github_archive_url() {
  local repo="${INSTALL_REPO%.git}"
  case "$repo" in
    https://github.com/*)
      printf '%s/archive/refs/heads/%s.tar.gz\n' "$repo" "$INSTALL_REF"
      ;;
    *)
      return 1
      ;;
  esac
}

download_archive() {
  local archive_url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$archive_url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$archive_url"
  else
    echo "install.sh: curl or wget is required when git is not available" >&2
    return 1
  fi
}

bootstrap_project_dir() {
  local target_dir
  target_dir="$(default_install_dir)"
  mkdir -p "$(dirname -- "$target_dir")"

  if command -v git >/dev/null 2>&1; then
    if [[ -d "$target_dir/.git" ]]; then
      echo "install.sh: updating $target_dir from $INSTALL_REPO ($INSTALL_REF)" >&2
      git -C "$target_dir" remote set-url origin "$INSTALL_REPO"
      git -C "$target_dir" fetch --depth 1 origin "$INSTALL_REF"
      git -C "$target_dir" checkout --force FETCH_HEAD
    else
      if [[ -e "$target_dir" ]]; then
        if [[ -f "$target_dir/.cdx-install-managed" ]]; then
          rm -rf "$target_dir"
        else
          echo "install.sh: install directory already exists and is not managed: $target_dir" >&2
          echo "install.sh: set CDX_INSTALL_DIR to another path or remove it manually" >&2
          exit 1
        fi
      fi
      echo "install.sh: cloning $INSTALL_REPO ($INSTALL_REF) into $target_dir" >&2
      git clone --depth 1 --branch "$INSTALL_REF" "$INSTALL_REPO" "$target_dir"
    fi
    touch "$target_dir/.cdx-install-managed"
    printf '%s\n' "$target_dir"
    return
  fi

  local archive_url
  if ! archive_url="$(github_archive_url)"; then
    echo "install.sh: git is required for non-GitHub install repo: $INSTALL_REPO" >&2
    exit 1
  fi

  if ! command -v tar >/dev/null 2>&1; then
    echo "install.sh: tar is required when git is not available" >&2
    exit 1
  fi

  local temp_dir extracted_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"; trap - RETURN' RETURN

  echo "install.sh: downloading $archive_url into $target_dir" >&2
  download_archive "$archive_url" | tar -xz -C "$temp_dir"
  extracted_dir="$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
    echo "install.sh: downloaded archive did not contain a project directory" >&2
    exit 1
  fi

  if [[ -e "$target_dir" ]]; then
    if [[ -f "$target_dir/.cdx-install-managed" ]]; then
      rm -rf "$target_dir"
    else
      echo "install.sh: install directory already exists and is not managed: $target_dir" >&2
      echo "install.sh: set CDX_INSTALL_DIR to another path or remove it manually" >&2
      exit 1
    fi
  fi

  mkdir -p "$target_dir"
  cp -R "$extracted_dir"/. "$target_dir"/
  touch "$target_dir/.cdx-install-managed"
  printf '%s\n' "$target_dir"
}

REMOTE_BOOTSTRAP=0
if [[ -n "${PROJECT_DIR:-}" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
else
  SCRIPT_DIR="$(script_dir_from_source || true)"
  if is_project_dir "$SCRIPT_DIR"; then
    PROJECT_DIR="$SCRIPT_DIR"
  else
    REMOTE_BOOTSTRAP=1
    PROJECT_DIR="$(bootstrap_project_dir)"
  fi
fi

if [[ "$REMOTE_BOOTSTRAP" == "1" && "$#" -eq 0 ]]; then
  set -- install
fi

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
