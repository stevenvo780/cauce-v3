#!/usr/bin/env bash
set -euo pipefail

# Publish the per-alias PTY ticket key derived from derive-alias-key.py.
# The script never overwrites an existing key and publishes alias-key.hex atomically (mode 0400).

tenant=""
alias_name=""
output_dir=""
master_file=""
master_env=""

while (( $# > 0 )); do
  case "$1" in
    --tenant)
      tenant="${2:-}"
      shift 2
      ;;
    --alias)
      alias_name="${2:-}"
      shift 2
      ;;
    --output-dir|-o)
      output_dir="${2:-}"
      shift 2
      ;;
    --master-file)
      master_file="${2:-}"
      shift 2
      ;;
    --master-env)
      master_env="${2:-}"
      shift 2
      ;;
    *)
      if [[ -z "$tenant" ]]; then
        tenant="$1"
      elif [[ -z "$alias_name" ]]; then
        alias_name="$1"
      elif [[ -z "$output_dir" ]]; then
        output_dir="$1"
      elif [[ -z "$master_file" && -z "$master_env" ]]; then
        if [[ -f "$1" ]]; then
          master_file="$1"
        else
          master_env="$1"
        fi
      else
        printf 'publish alias key failed: unexpected argument %s\n' "$1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$master_file" && -z "$master_env" ]]; then
  if [[ -n "${CAUCE_PTY_MASTER_FILE:-}" ]]; then
    master_file="$CAUCE_PTY_MASTER_FILE"
  elif [[ -n "${CAUCE_PTY_MASTER_ENV:-}" ]]; then
    master_env="$CAUCE_PTY_MASTER_ENV"
  elif [[ -n "${CAUCE_PTY_MASTER:-}" ]]; then
    master_env="CAUCE_PTY_MASTER"
  fi
fi

[[ -n "$tenant" && -n "$alias_name" && -n "$output_dir" && ( -n "$master_file" || -n "$master_env" ) ]] || {
  printf 'usage: %s --tenant <tenant> --alias <alias> --output-dir /abs/dir [--master-file /abs/path | --master-env ENV_VAR]\n' "${0##*/}" >&2
  exit 2
}

[[ $tenant =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'publish alias key failed: invalid tenant identifier\n' >&2
  exit 2
}

[[ $alias_name =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'publish alias key failed: invalid alias identifier\n' >&2
  exit 2
}

[[ $output_dir == /* && ! -L $output_dir ]] || {
  printf 'publish alias key failed: output directory must be absolute and not a symlink\n' >&2
  exit 2
}

if [[ -n "$master_file" ]]; then
  [[ $master_file == /* && -f $master_file && ! -L $master_file ]] || {
    printf 'publish alias key failed: master file must be an absolute regular non-symlink file\n' >&2
    exit 2
  }
fi

command -v flock >/dev/null 2>&1 || {
  printf 'publish alias key failed: flock is unavailable\n' >&2
  exit 127
}

command -v python3 >/dev/null 2>&1 || {
  printf 'publish alias key failed: python3 is unavailable\n' >&2
  exit 127
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
derive_script="$script_dir/derive-alias-key.py"
[[ -f "$derive_script" ]] || {
  printf 'publish alias key failed: derive-alias-key.py not found at %s\n' "$derive_script" >&2
  exit 1
}

umask 077
install -d -m 0700 -- "$output_dir"
exec 9>"$output_dir/.alias-key-publish.lock"
flock -x 9

final_key="$output_dir/alias-key.hex"
[[ ! -e $final_key && ! -L $final_key ]] || {
  printf 'publish alias key failed: destination credential already exists; nothing was overwritten\n' >&2
  exit 1
}

work=$(mktemp -d "$output_dir/.alias-key.XXXXXX")
published_key=0
cleanup() {
  status=$?
  rm -rf -- "$work"
  if (( status != 0 && published_key == 0 )); then
    rm -f -- "$final_key"
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

derive_args=(--tenant "$tenant" --alias "$alias_name")
if [[ -n "$master_file" ]]; then
  derive_args+=(--master-file "$master_file")
else
  derive_args+=(--master-env "$master_env")
fi

key_output=$(python3 "$derive_script" "${derive_args[@]}")
key_trimmed=$(printf '%s' "$key_output" | tr -d '\r\n')

[[ $key_trimmed =~ ^[0-9a-fA-F]{64}$ ]] || {
  printf 'publish alias key failed: derive-alias-key.py returned unexpected output\n' >&2
  exit 1
}

printf '%s\n' "$key_trimmed" > "$work/alias-key.hex"

if (( EUID == 0 )); then
  chown 1000:1000 "$work/alias-key.hex" 2>/dev/null || true
fi
chmod 0400 "$work/alias-key.hex"

ln "$work/alias-key.hex" "$final_key"
published_key=1

printf 'alias key publishing passed: alias-key.hex issued for %s/%s (mode 0400)\n' "$tenant" "$alias_name"
