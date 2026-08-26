#!/usr/bin/env bash
#
# Compatibility tombstone for the retired console-only release path.
#
# Production releases are created by release-build.sh and selected with one
# six-field compare-and-swap: runtime image, console image, override manifest
# path and SHA-256, rollback baseline path and rollback baseline SHA-256. Keeping a second writer
# here would let old automation bypass that transaction, its registry recovery
# proof and rollback.sh compensation.
set -euo pipefail

action=${1:-help}

retired_mutation() {
  printf '%s\n' \
    'ERROR: el camino historico release-console esta retirado y no puede modificar produccion.' \
    '' \
    'Construccion y publicacion: ops/scripts/release-build.sh (runtime y consola del mismo RC limpio).' \
    'Deploy: ops/scripts/deploy-release.sh mantiene locked-exec durante CAS, migracion, health y evidencia.' \
    'Reversa: ops/scripts/rollback.sh console, usando el baseline autenticado y compensacion automatica.' \
    '' \
    'Consulta ops/runbooks/deploy.md y ops/runbooks/rollback.md. Esta accion falla antes de ejecutar' \
    'comandos de contenedores, transporte remoto o escrituras.' >&2
  exit 64
}

immutable_image_reference() {
  local reference=$1
  local component='[a-z0-9]+([._-][a-z0-9]+)*'
  local pattern="^${component}(:[0-9]+)?(/${component})+@sha256:[a-f0-9]{64}$"
  [[ $reference =~ $pattern ]]
}

read_console_selector() {
  local env_file=$1 line value='' count=0
  [[ -f $env_file && ! -L $env_file && -r $env_file ]] || {
    printf 'verificacion rechazada: CAUCE_ENV_FILE debe ser un fichero regular, legible y no symlink\n' >&2
    return 2
  }

  # Read only the selector. Never source or print the production environment:
  # it can contain paths to credentials and unrelated private configuration.
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      CAUCE_CONSOLE_IMAGE=*)
        value=${line#CAUCE_CONSOLE_IMAGE=}
        count=$((count + 1))
        ;;
    esac
  done < "$env_file"

  [[ $count -eq 1 && -n $value ]] || {
    printf 'verificacion rechazada: CAUCE_ENV_FILE debe contener un unico CAUCE_CONSOLE_IMAGE\n' >&2
    return 2
  }
  printf '%s\n' "$value"
}

verify_reference() {
  local reference=${2:-${CAUCE_CONSOLE_IMAGE:-}}
  if [[ -z $reference && -n ${CAUCE_ENV_FILE:-} ]]; then
    reference=$(read_console_selector "$CAUCE_ENV_FILE")
  fi
  [[ -n $reference ]] || {
    printf 'uso read-only: CAUCE_CONSOLE_IMAGE=<repository@sha256> %s verificar\n' "$0" >&2
    printf '               CAUCE_ENV_FILE=/ruta/privada/prod.env %s verificar\n' "$0" >&2
    return 2
  }
  immutable_image_reference "$reference" || {
    printf 'verificacion rechazada: la consola no es un RepoDigest canonico e inmutable\n' >&2
    return 2
  }

  printf 'selector de consola inmutable y sintacticamente valido: %s\n' "$reference"
  printf 'alcance: comprobacion local read-only; no acredita imagen recuperada, CAS ni servicio vivo\n'
}

case $action in
  desplegar|deploy|revertir|rollback)
    retired_mutation
    ;;
  verificar|verify)
    verify_reference "$@"
    ;;
  help|-h|--help|ayuda)
    printf '%s\n' \
      "uso: $0 verificar [repository@sha256]" \
      '' \
      'Las acciones desplegar/revertir estan retiradas y fallan cerrado. El unico comando conservado' \
      'valida un selector de consola sin ejecutar operaciones externas ni modificar estado.'
    ;;
  *)
    printf 'accion desconocida: %s\n' "$action" >&2
    printf 'uso: %s verificar [repository@sha256]\n' "$0" >&2
    exit 2
    ;;
esac
