#!/usr/bin/env bash
# Si TODO el catalogo vuelve a responder, el estado de avisadas debe vaciarse: si no, una URL que
# entro por un pico queda apuntada y su caida real posterior ya no cuenta como nueva (aviso mudo).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VIGIA="$HERE/../guardias/catalogo-mouseion-health.sh"
WORK=$(mktemp -d)
# shellcheck disable=SC2329  # invocada por el trap EXIT
limpiar() { rm -rf "$WORK"; }
trap limpiar EXIT
mkdir -p "$WORK/bin"
# curl falso: todo responde 200 con un cuerpo grande y el marcador pedido.
cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
salida=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) salida=$2; shift 2 ;; -w|--max-time) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
{ printf 'marca-ok '; head -c 4096 /dev/zero | tr '\0' x; } > "$salida"
printf '200 4105 %s' "$url"
CURL
chmod +x "$WORK/bin/curl"
printf 'https://uno.example/\tmarca-ok\nhttps://dos.example/\tmarca-ok\n' > "$WORK/urls.txt"
printf 'https://uno.example/\n' > "$WORK/informe.avisadas"
PATH="$WORK/bin:$PATH" CATALOGO_URLS="$WORK/urls.txt" CATALOGO_INFORME="$WORK/informe.log" \
  CATALOGO_REINTENTO=0 bash "$VIGIA" >/dev/null 2>&1
rc=$?
if [ "$rc" = 0 ] && [ ! -s "$WORK/informe.avisadas" ]; then
  echo "ok: con todo en 200 el estado de avisadas queda vacio"
else
  echo "FAIL: con todo en 200 el estado sigue con: $(cat "$WORK/informe.avisadas" 2>/dev/null) (rc=$rc)" >&2
  exit 1
fi
