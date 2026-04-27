#!/usr/bin/env bash
set -euo pipefail

DEFAULT_INSTALL_REPO="https://github.com/cdx-org/cdx.git"
DEFAULT_INSTALL_REF="main"
INSTALL_MANAGED_MARKER=".cdx-install-managed"

INSTALL_REPO="${CDX_INSTALL_REPO:-$DEFAULT_INSTALL_REPO}"
INSTALL_REF="${CDX_INSTALL_REF:-$DEFAULT_INSTALL_REF}"
INSTALL_SKIP_UPDATE="${CDX_INSTALL_SKIP_UPDATE:-0}"

warn() {
  printf '%s\n' "install.sh: $*" >&2
}

fail() {
  warn "$*"
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

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

remove_managed_install_dir() {
  local target_dir="$1"
  if [[ ! -e "$target_dir" ]]; then
    return
  fi
  if [[ ! -f "$target_dir/$INSTALL_MANAGED_MARKER" ]]; then
    fail "install directory already exists and is not managed: $target_dir
install.sh: set CDX_INSTALL_DIR to another path or remove it manually"
  fi
  rm -rf "$target_dir"
}

update_checkout() {
  local target_dir="$1"
  [[ "$INSTALL_SKIP_UPDATE" == "1" ]] && return
  [[ -d "$target_dir/.git" ]] || return

  if [[ -n "$(git -C "$target_dir" status --porcelain 2>/dev/null || true)" ]]; then
    warn "skipping installer repo update because $target_dir has local changes"
    return
  fi

  warn "updating $target_dir from $INSTALL_REPO ($INSTALL_REF)"
  git -C "$target_dir" remote set-url origin "$INSTALL_REPO" >/dev/null 2>&1 || true
  git -C "$target_dir" fetch --depth 1 origin "$INSTALL_REF" >/dev/null 2>&1 || return
  git -C "$target_dir" checkout --force FETCH_HEAD >/dev/null 2>&1 || return
}

download_archive() {
  local archive_url="$1"
  if have_cmd curl; then
    curl -fsSL "$archive_url"
  elif have_cmd wget; then
    wget -qO- "$archive_url"
  else
    fail "curl or wget is required when git is not available"
  fi
}

ensure_project_checkout() {
  local target_dir="$1"

  if is_project_dir "$target_dir"; then
    update_checkout "$target_dir"
    return
  fi

  if [[ -e "$target_dir" && ! -d "$target_dir/.git" ]]; then
    remove_managed_install_dir "$target_dir"
  fi

  mkdir -p "$(dirname -- "$target_dir")"

  if have_cmd git; then
    if [[ -d "$target_dir/.git" ]]; then
      update_checkout "$target_dir"
      is_project_dir "$target_dir" || fail "git checkout is missing mcp-cdx files: $target_dir"
    else
      warn "cloning $INSTALL_REPO ($INSTALL_REF) into $target_dir"
      git clone --depth 1 --branch "$INSTALL_REF" "$INSTALL_REPO" "$target_dir"
      is_project_dir "$target_dir" || fail "clone did not produce an mcp-cdx checkout: $target_dir"
    fi
    touch "$target_dir/$INSTALL_MANAGED_MARKER"
    return
  fi

  local archive_url
  if ! archive_url="$(github_archive_url)"; then
    fail "git is required for non-GitHub install repo: $INSTALL_REPO"
  fi

  if ! have_cmd tar; then
    fail "tar is required when git is not available"
  fi

  local temp_dir extracted_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"; trap - RETURN' RETURN

  warn "downloading $archive_url into $target_dir"
  download_archive "$archive_url" | tar -xz -C "$temp_dir"
  extracted_dir="$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
    fail "downloaded archive did not contain a project directory"
  fi
  is_project_dir "$extracted_dir" || fail "downloaded archive did not contain an mcp-cdx checkout"

  if [[ -e "$target_dir" ]]; then
    remove_managed_install_dir "$target_dir"
  fi

  mkdir -p "$target_dir"
  cp -R "$extracted_dir"/. "$target_dir"/
  touch "$target_dir/$INSTALL_MANAGED_MARKER"
}

bootstrap_project_dir() {
  local target_dir
  target_dir="$(default_install_dir)"
  ensure_project_checkout "$target_dir"
  printf '%s\n' "$target_dir"
}

if [[ -n "${PROJECT_DIR:-}" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
else
  SCRIPT_DIR="$(script_dir_from_source || true)"
  if is_project_dir "$SCRIPT_DIR"; then
    PROJECT_DIR="$SCRIPT_DIR"
  elif is_project_dir "$(pwd)"; then
    PROJECT_DIR="$(pwd)"
  else
    PROJECT_DIR="$(bootstrap_project_dir)"
  fi
fi

if [[ "$#" -eq 0 ]]; then
  set -- install
fi

NODE_BIN="${INSTALL_NODE_BIN:-node}"
NPM_BIN="${INSTALL_NPM_BIN:-npm}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
INSTALL_NPM_COMMAND="${INSTALL_NPM_COMMAND:-install}"
INSTALL_NPM_EXTRA_ARGS="${INSTALL_NPM_EXTRA_ARGS:---no-fund --no-audit}"
INSTALLER="$PROJECT_DIR/src/install/cli.js"
COMMAND="${1:-help}"

refresh_node_path() {
  for candidate in /opt/homebrew/bin /usr/local/bin /usr/local/sbin; do
    [[ -d "$candidate" ]] || continue
    case ":$PATH:" in
      *":$candidate:"*) ;;
      *) PATH="$candidate:$PATH" ;;
    esac
  done
  export PATH
}

node_version_text() {
  "$NODE_BIN" -p 'process.versions.node' 2>/dev/null || "$NODE_BIN" --version 2>/dev/null | sed 's/^v//' || true
}

node_runtime_ok() {
  local require_npm="${1:-1}"
  refresh_node_path
  local version major minor rest
  version="$(node_version_text | sed -n 's/^v//; /^[0-9][0-9]*\.[0-9][0-9]*\./{p;q;}')"
  [[ -n "$version" ]] || return 1
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > 18 || (major == 18 && minor >= 17) )) || return 1
  [[ "$require_npm" != "1" ]] || "$NPM_BIN" --version >/dev/null 2>&1 || return 1
}

ensure_node_runtime() {
  [[ "${SKIP_NODE_CHECK:-0}" == "1" ]] && return
  local require_npm=1
  [[ "$INSTALL_DEPS" == "0" ]] && require_npm=0
  if node_runtime_ok "$require_npm"; then
    return
  fi

  if [[ "$require_npm" == "1" ]]; then
    warn "Node.js >= 18.17 with npm is required"
  else
    warn "Node.js >= 18.17 is required"
  fi
  warn "Install Node.js, set INSTALL_NODE_BIN/INSTALL_NPM_BIN, or set SKIP_NODE_CHECK=1 to bypass this check"
  exit 1
}

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
  ensure_node_runtime
  run_dependency_install
fi

exec "$NODE_BIN" "$INSTALLER" "$@"
