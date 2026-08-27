#!/bin/bash
set -euo pipefail

# Bash imports exported functions before executing this file.  Remove every
# caller-supplied function before resolving any command, then use one canonical
# system path.  Production lock authentication must never be replaceable with a
# PATH shim or an exported `python3`/`docker` function.
while IFS= read -r inherited_function; do
  builtin unset -f -- "$inherited_function"
done < <(builtin compgen -A function)
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT NODE_OPTIONS

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:?usage: compose.sh dev|test|prod <compose args...>}
shift

if [[ $target == prod ]]; then
  system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  PATH=$system_path
  export PATH
fi

docker_bin=$(command -v docker)
[[ $docker_bin = /* && -x $docker_bin ]] || { printf 'trusted Docker CLI is unavailable\n' >&2; exit 127; }
readonly docker_bin

case "$target" in
  dev) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/dev.env"} ;;
  test) env_file= ;;
  prod) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"} ;;
  *) printf 'unsupported compose target: %s\n' "$target" >&2; exit 2 ;;
esac

env_args=()
if [[ -n $env_file ]]; then
  [[ -f $env_file ]] || { printf 'missing private env file: %s (copy the matching .example)\n' "$env_file" >&2; exit 2; }
  env_args=(--env-file "$env_file")

  # Only these non-secret control values are needed before Compose starts. Parse
  # them as data instead of sourcing the secret-bearing env. In production the
  # manifest path+SHA is a durable selector; a differing preview is rejected.
  selector_preview=0
  for control in CAUCE_LOCAL_POSTGRES CAUCE_COMPOSE_OVERRIDE_MANIFEST \
    CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256 CAUCE_COMPOSE_OVERRIDES_DIR; do
    ambient_set=0
    ambient_value=
    if [[ -v $control ]]; then
      ambient_set=1
      ambient_value=${!control}
    fi
    mapfile -t matches < <(sed -n "/^${control}=/p" "$env_file")
    ((${#matches[@]} <= 1)) || { printf 'duplicate %s in %s\n' "$control" "$env_file" >&2; exit 2; }
    value=
    if ((${#matches[@]} == 1)); then
      value=${matches[0]#*=}; value=${value%$'\r'}
      [[ $value != *$'\n'* ]] || { printf 'invalid newline in %s\n' "$control" >&2; exit 2; }
    fi
    if [[ $target == prod && $control =~ ^CAUCE_COMPOSE_OVERRIDE_MANIFEST(_SHA256)?$ \
       && $ambient_set == 1 && $ambient_value != "$value" ]]; then
      selector_preview=1
      continue
    fi
    if [[ $target == prod || $ambient_set == 0 ]]; then
      printf -v "$control" '%s' "$value"
      export "$control"
    fi
  done
  if [[ $target == prod && $selector_preview == 1 ]]; then
    printf 'production Compose selector preview is disabled outside deployment tooling\n' >&2
    exit 2
  fi
fi

# A production read-only invocation uses a fixed engine and credential authority.
# The selected env file remains Compose's data input, but ambient Docker/Compose
# controls cannot redirect it to another daemon, context, project or credential store.
if [[ $target == prod ]]; then
  trusted_home=$(getent passwd "$(id -u)" | cut -d: -f6)
  trusted_user=$(id -un)
  [[ $trusted_home = /* && -d $trusted_home && ! -L $trusted_home ]] || {
    printf 'production Compose invoking account has no trusted home\n' >&2
    exit 2
  }
  HOME=$trusted_home
  USER=$trusted_user
  LOGNAME=$trusted_user
  DOCKER_HOST=unix:///var/run/docker.sock
  DOCKER_CONFIG=$trusted_home/.docker
  if [[ -e $DOCKER_CONFIG || -L $DOCKER_CONFIG ]]; then
    [[ -d $DOCKER_CONFIG && ! -L $DOCKER_CONFIG ]] || {
      printf 'production Compose trusted Docker config path is unsafe\n' >&2
      exit 2
    }
    read -r docker_config_owner docker_config_mode < <(stat -c '%u %a' -- "$DOCKER_CONFIG")
    [[ ( $docker_config_owner == 0 || $docker_config_owner == "$(id -u)" ) \
       && $((8#$docker_config_mode & 0022)) == 0 ]] || {
      printf 'production Compose trusted Docker config directory is not protected\n' >&2
      exit 2
    }
  fi
  export HOME USER LOGNAME DOCKER_HOST DOCKER_CONFIG
  unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
    DOCKER_AUTH_CONFIG DOCKER_DEFAULT_PLATFORM BUILDKIT_HOST BUILDX_CONFIG \
    COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE \
    COMPOSE_IGNORE_ORPHANS COMPOSE_REMOVE_ORPHANS COMPOSE_PROJECT_NAME COMPOSE_PROFILES
fi

production_compose_is_read_only() {
  local command=${1:-}
  shift || true
  case $command in
    events|images|logs|ls|port|ps|top|version|help|--help)
      return 0
      ;;
    config)
      local argument expect_value=0 positional_only=0
      while (($#)); do
        argument=$1
        shift
        if ((positional_only)); then
          continue
        fi
        if ((expect_value)); then
          expect_value=0
          continue
        fi
        case $argument in
          --)
            positional_only=1
            ;;
          --format|--hash)
            expect_value=1
            ;;
          --format=*|--hash=*|--dry-run|--environment|--images|--models|--networks|\
          --no-consistency|--no-env-resolution|--no-interpolate|--no-normalize|\
          --no-path-resolution|--profiles|--quiet|-q|--resolve-image-digests|\
          --services|--variables|--volumes)
            ;;
          -*)
            # Includes -o/--output, --lock-image-digests and future flags.
            # Unknown config flags fail closed because Compose may add another
            # file-producing option in a later release.
            return 1
            ;;
          *)
            # Positional service filters are read-only data.
            ;;
        esac
      done
      ((expect_value == 0))
      return
      ;;
    *)
      return 1
      ;;
  esac
}

# A production Compose invocation is read-only only when its first token is one
# of this deliberately small top-level allowlist.  Global flags, unknown/new
# subcommands, `exec`, `run`, `cp`, image-cache operations and every lifecycle
# command fail closed outside deployment tooling. In particular, `--dry-run
# down` is still a production mutation preview and remains disabled here.
if [[ $target == prod ]]; then
  production_compose_is_read_only "$@" || {
    printf 'production Compose mutation is disabled outside deployment tooling\n' >&2
    exit 2
  }
fi

"$docker_bin" compose version >/dev/null 2>&1 || { printf 'Docker Compose v2 is required\n' >&2; exit 127; }
list=$("$ROOT/scripts/compose-files.sh" "$target") || {
  rc=$?
  printf 'compose.sh: refusing to continue with an incomplete Compose file set (rc=%s)\n' "$rc" >&2
  exit "$rc"
}
compose_files=()
while IFS= read -r file; do
  [[ -n $file ]] || continue
  [[ -f $file && -r $file ]] || { printf 'compose file is unreadable: %s\n' "$file" >&2; exit 3; }
  compose_files+=(-f "$file")
done <<<"$list"
((${#compose_files[@]} > 0)) || { printf 'compose file set is empty\n' >&2; exit 3; }
exec "$docker_bin" compose "${env_args[@]}" "${compose_files[@]}" "$@"
