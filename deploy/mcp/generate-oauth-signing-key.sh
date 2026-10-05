#!/usr/bin/env bash
set -euo pipefail

OUT=${1:?usage: generate-oauth-signing-key.sh <ruta-de-salida-pkcs8-pem>}
[ ! -e "$OUT" ] || { printf 'me niego a sobrescribir una clave existente: %s\n' "$OUT" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf 'falta openssl\n' >&2; exit 127; }

umask 077
DIRECTORY=$(dirname -- "$OUT")
[ -d "$DIRECTORY" ] || { printf 'no existe el directorio destino: %s\n' "$DIRECTORY" >&2; exit 1; }
TMP=$(mktemp "$DIRECTORY/.mcp-oauth-signing-key.XXXXXX")
trap 'rm -f "$TMP"' EXIT

openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt -out "$TMP"
chmod 0400 "$TMP"
mv -- "$TMP" "$OUT"
trap - EXIT

printf 'clave de firma P-256 (PKCS8, sin cifrar) escrita en: %s\n' "$OUT" >&2
printf 'definila como CAUCE_MCP_OAUTH_SIGNING_KEY_PATH y elegi un CAUCE_MCP_OAUTH_SIGNING_KID nuevo para esta clave; nunca reutilices un kid con una clave distinta\n' >&2
