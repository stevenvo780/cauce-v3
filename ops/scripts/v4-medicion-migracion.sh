#!/usr/bin/env bash
# Single entry point for the V4 migration cut package: read-only before/after measurement of a Docker
# host and its aliases, and the recoverable pre-cut copy with its test restore.
# The measurement runs on the measured host (locally or piped through ssh); the copy runs where the data lives.
set -euo pipefail

here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
measure=$here/v4_medicion_migracion.py
copier=$here/v4_copia_migracion.py
config_default=$(dirname "$here")/container-aliases.json

usage() {
  cat >&2 <<'EOF'
usage: v4-medicion-migracion.sh medir (--ssh DEST | --local | --ruta-declarada) --label NAME [--out FILE]
                                      (--alcance FILE | --alcance-de RECEIPT | [--config FILE] ALIAS...)
       v4-medicion-migracion.sh verificar RECEIPT
       v4-medicion-migracion.sh comparar BEFORE AFTER
       v4-medicion-migracion.sh copiar --alias ALIAS --empresa TENANT [--config FILE]
                                       --origen NAME=/dir [--origen ...] --destino DIR
       v4-medicion-migracion.sh comprobar-copia DIR
       v4-medicion-migracion.sh restaurar DIR --alias ALIAS --empresa TENANT [--destino DIR] [--propietario UID:GID]
                                          [--mapa OLD=NEW ...] [--omitir GLOB ...] [--duplicar OLD=NEW ...] [--recibo FILE]
EOF
  exit 2
}

py() { PYTHONDONTWRITEBYTECODE=1 python3 -I -B "$@"; }

declared_route() {  # $1=scope JSON -> the single route every alias declares
  py -c 'import json, sys
routes = {e["declaredRoute"] for e in json.loads(sys.argv[1])["aliases"].values()}
if len(routes) != 1:
    raise SystemExit("aliases declare different routes: " + ", ".join(sorted(routes)))
print(routes.pop())' "$1"
}

cmd_medir() {
  local dest='' via='' label='' out='' scope_file='' scope_from='' config=$config_default declared=0 scope receipt
  local aliases=()
  while (($#)); do
    case $1 in
      --ssh) (($# >= 2)) || usage; dest=$2; via="ssh:$2"; shift 2 ;;
      --local) via=local; shift ;;
      --ruta-declarada) declared=1; shift ;;
      --label) (($# >= 2)) || usage; label=$2; shift 2 ;;
      --out) (($# >= 2)) || usage; out=$2; shift 2 ;;
      --alcance) (($# >= 2)) || usage; scope_file=$2; shift 2 ;;
      --alcance-de) (($# >= 2)) || usage; scope_from=$2; shift 2 ;;
      --config) (($# >= 2)) || usage; config=$2; shift 2 ;;
      -*) usage ;;
      *) aliases+=("$1"); shift ;;
    esac
  done
  [[ $label =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { printf 'invalid or missing --label\n' >&2; exit 2; }
  if [[ -n $scope_file ]]; then
    scope=$(py "$measure" validar-alcance "$scope_file")
  elif [[ -n $scope_from ]]; then
    scope=$(py "$measure" alcance-de "$scope_from")
  else
    ((${#aliases[@]})) || usage
    scope=$(py "$measure" alcance "$config" "${aliases[@]}")
  fi
  if ((declared)); then
    [[ -z $via ]] || { printf -- '--ruta-declarada excludes --ssh and --local\n' >&2; exit 2; }
    via=$(declared_route "$scope")
    [[ $via == ssh:* ]] || { printf 'the declared route is %s; measure the main host with --ssh or --local\n' "$via" >&2; exit 2; }
    dest=${via#ssh:}
  fi
  [[ -n $via ]] || { printf 'choose --ssh DEST, --local or --ruta-declarada\n' >&2; exit 2; }
  local encoded
  encoded=$(printf '%s' "$scope" | base64 -w0)
  if [[ -n $dest ]]; then
    receipt=$(ssh -o BatchMode=yes "$dest" "$(printf '%q ' python3 -I -B - medir "$label" "$encoded" "$via")" <"$measure")
  else
    receipt=$(py "$measure" medir "$label" "$encoded" "$via")
  fi
  if [[ -n $out ]]; then
    [[ ! -e $out ]] || { printf 'refusing to overwrite %s\n' "$out" >&2; exit 1; }
    (umask 077; printf '%s\n' "$receipt" >"$out")
    py "$measure" verificar "$out"
  else
    printf '%s\n' "$receipt"
  fi
}

(($#)) || usage
command=$1
shift
case $command in
  medir) cmd_medir "$@" ;;
  verificar) (($# == 1)) || usage; py "$measure" verificar "$1" ;;
  comparar) (($# == 2)) || usage; py "$measure" comparar "$1" "$2" ;;
  copiar|comprobar-copia|restaurar) py "$copier" "$command" "$@" ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
