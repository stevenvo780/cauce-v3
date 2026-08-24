#!/usr/bin/env bash
#
# Aplica a UN alias el plan de `separar-config-alias.mjs` y COMPRUEBA POR EFECTO antes de declarar
# éxito.
#
# POR QUÉ NO BASTA CON QUE `cp` DEVUELVA 0
# ========================================
#
# `cp` devuelve 0 con el fichero que importa sin copiar: porque el origen no existía, porque el
# plan lo nombró en otra ruta, o porque lo que quedó en el destino es un enlace al mismo inodo de
# siempre. Ninguno de esos tres estados produce un error visible después: el alias arranca igual.
# Si además falta el `.claude.json`, arranca sin UN SOLO servidor MCP y sin un solo mensaje de
# error — se queda mudo de capacidades y parece un problema del modelo.
#
# Por eso este guion no cree a `cp`. Al terminar MIDE:
#
#   1. que el directorio nuevo existe y el fichero testigo está DENTRO;
#   2. que el inodo del testigo ya NO coincide con el del origen ni con el del alias que compartía
#      (un directorio lleno de enlaces duros tiene todos los ficheros en su sitio y no ha separado
#      absolutamente nada);
#   3. que el `.claude.json` llegó, es legible y CUÁNTOS servidores MCP trae — "existe" no
#      distingue el fichero bueno de un `{}` que arranca igual y deja al alias sin herramientas.
#
# LO QUE NUNCA HACE
# =================
#
# Borrar. El directorio de origen ES la reversa: mientras siga intacto, volver atrás es quitar una
# variable de entorno y borrar el directorio nuevo. Un plan que traiga borrados se RECHAZA antes de
# tocar el disco.
#
# USO
#   aplicar-separacion-config.sh --plan <fichero|-> [--comparar-con <ruta>] [--solo-verificar] [--rehacer]
#
# Códigos de salida: 0 = aplicado y comprobado; 1 = la comprobación por efecto falló; 2 = el plan o
# los argumentos no se entienden. Un fallo de comprobación NUNCA sale con 0.

set -euo pipefail

plan_origen=''
comparar_con=''
solo_verificar=false
rehacer=false

variable='' testigo='' directorio_origen='' directorio_destino='' reversa='' alias_nombre='' arnes=''

morir() { printf 'aplicar-separacion-config: %s\n' "$*" >&2; exit "${2:-2}"; }

# Todo fallo imprime la reversa. Un ejecutor que falla a medias y se calla cómo volver atrás deja
# al operador adivinando qué quedó escrito.
fallo_comprobacion() {
  printf '\nFALLO DE COMPROBACIÓN: %s\n' "$1" >&2
  imprimir_reversa >&2
  exit 1
}

# Se imprimen las ÓRDENES concretas, no la frase del plan. "Revertí el cambio" obliga a
# reconstruir de memoria qué directorio se creó y qué variable se puso, que es justo lo que no se
# recuerda bien cuando algo acaba de fallar. El texto largo del plan ya está en el propio plan.
imprimir_reversa() {
  printf '\nCÓMO SE REVIERTE (el origen %s no se tocó en ningún momento):\n' "${directorio_origen:-<sin plan>}"
  printf '  1) quitar %s del entorno del alias: borrar CONFIG_POR_ALIAS=1 de su .env y reiniciarlo.\n' "${variable:-la variable del arnés}"
  printf '  2) borrar el directorio nuevo: rm -rf %s\n' "${directorio_destino:-<sin plan>}"
}

while (($#)); do
  case "$1" in
    --plan) plan_origen=${2:-}; shift 2 ;;
    --comparar-con) comparar_con=${2:-}; shift 2 ;;
    --solo-verificar) solo_verificar=true; shift ;;
    --rehacer) rehacer=true; shift ;;
    *) morir "argumento desconocido: $1" ;;
  esac
done
[[ -n $plan_origen ]] || morir 'falta --plan <fichero|->'

if [[ $plan_origen == - ]]; then plan_json=$(cat); else plan_json=$(cat -- "$plan_origen"); fi

# ---------------------------------------------------------------------------
# Lectura del plan. La validación vive en Python porque el shell no puede leer JSON sin inventarse
# un analizador, y un analizador inventado es exactamente cómo un campo mal leído se convierte en
# una ruta equivocada que sí existe.
# ---------------------------------------------------------------------------
leer_plan() {
  python3 - "$1" <<'PY'
import json, sys

try:
    plan = json.loads(sys.argv[1])
except json.JSONDecodeError as error:
    sys.exit(f"el plan no es JSON válido: {error}")

if not isinstance(plan, dict):
    sys.exit("el plan tiene que ser un objeto")

for campo in ("alias", "arnes", "variable", "testigo", "directorioOrigen", "directorioDestino",
              "copias", "borrados", "reversa"):
    if campo not in plan:
        sys.exit(f"el plan no trae el campo {campo}")

# EL RECHAZO DURO. El origen es la reversa: ningún plan puede pedir que se borre. Si algún día el
# planificador crece una lista de borrados, esto para la aplicación en seco en vez de descubrirlo
# cuando ya no haya a dónde volver.
if plan["borrados"]:
    sys.exit(
        "el plan trae borrados y este ejecutor no borra NADA: el directorio de origen es la "
        f"reversa. Borrados pedidos: {plan['borrados']}"
    )

destino = plan["directorioDestino"]
if not isinstance(destino, str) or not destino.startswith("/") or "//" in destino:
    sys.exit("directorioDestino tiene que ser una ruta absoluta canónica")

copias = plan["copias"]
if not isinstance(copias, list) or not copias:
    sys.exit("el plan no trae ninguna copia")

for copia in copias:
    ruta = copia["destino"]
    # Una copia que escribe fuera del directorio del alias no es parte de esta separación.
    if ruta != destino and not ruta.startswith(destino + "/"):
        sys.exit(f"la copia a {ruta} cae fuera del directorio del alias ({destino})")

campos = [plan["alias"], plan["arnes"], plan["variable"], plan["testigo"],
          plan["directorioOrigen"], destino, plan["reversa"], str(len(copias))]
for copia in copias:
    campos += [copia["tipo"], copia["origen"], copia["destino"],
               "1" if copia.get("obligatorio") else "0"]
sys.stdout.write("\0".join(campos))
PY
}

mapfile -d '' -t campos < <(leer_plan "$plan_json" && printf '\0') || morir "$(leer_plan "$plan_json" 2>&1 >/dev/null)"
[[ ${#campos[@]} -gt 0 ]] || morir 'el plan no se pudo leer'

alias_nombre=${campos[0]}; arnes=${campos[1]}; variable=${campos[2]}; testigo=${campos[3]}
directorio_origen=${campos[4]}; directorio_destino=${campos[5]}; reversa=${campos[6]}
numero_copias=${campos[7]}

copia_tipo=() copia_origen=() copia_destino=() copia_obligatoria=()
for ((i = 0; i < numero_copias; i++)); do
  base=$((8 + i * 4))
  copia_tipo+=("${campos[$base]}")
  copia_origen+=("${campos[$((base + 1))]}")
  copia_destino+=("${campos[$((base + 2))]}")
  copia_obligatoria+=("${campos[$((base + 3))]}")
done

identidad() { stat -c '%d:%i' -- "$1"; }

# ---------------------------------------------------------------------------
# Aplicación.
# ---------------------------------------------------------------------------
if [[ $solo_verificar == false ]]; then
  # Comprobación previa: TODO origen obligatorio tiene que existir ANTES de copiar nada. Descubrir
  # a mitad que falta el `.claude.json` deja al alias apuntando a un directorio sin MCP.
  for ((i = 0; i < numero_copias; i++)); do
    [[ ${copia_obligatoria[$i]} == 1 ]] || continue
    if [[ ! -e ${copia_origen[$i]} ]]; then
      morir "el origen obligatorio no existe y sin él la separación deja al alias incompleto: ${copia_origen[$i]}"
    fi
  done
  [[ -e "$directorio_origen/$testigo" ]] \
    || morir "el fichero testigo no existe en el origen: $directorio_origen/$testigo (sin él no se puede comprobar por efecto que la separación ocurrió)"

  if [[ -e $directorio_destino && $rehacer == false ]]; then
    morir "el destino ya existe: $directorio_destino (usá --rehacer si de verdad querés reescribirlo)"
  fi

  mkdir -p -- "$directorio_destino"
  for ((i = 0; i < numero_copias; i++)); do
    case "${copia_tipo[$i]}" in
      # `cp -a` copia CONTENIDO nuevo: no enlaza duro. La comprobación de inodo de más abajo es la
      # que lo acredita, no esta línea.
      directorio) cp -a -- "${copia_origen[$i]}/." "${copia_destino[$i]}/" ;;
      fichero)
        mkdir -p -- "$(dirname -- "${copia_destino[$i]}")"
        cp -p -- "${copia_origen[$i]}" "${copia_destino[$i]}"
        ;;
      *) morir "tipo de copia desconocido: ${copia_tipo[$i]}" ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# COMPROBACIÓN POR EFECTO. Nada de lo de arriba cuenta hasta que esto pasa.
# ---------------------------------------------------------------------------
printf 'Comprobación por efecto de %s (%s):\n' "$alias_nombre" "$arnes"

[[ -d $directorio_destino ]] || fallo_comprobacion "el directorio nuevo no existe: $directorio_destino"
printf '  [ok] el directorio nuevo existe: %s\n' "$directorio_destino"

destino_testigo="$directorio_destino/$testigo"
[[ -f $destino_testigo ]] || fallo_comprobacion "el fichero testigo no está dentro del directorio nuevo: $destino_testigo"
printf '  [ok] el testigo está dentro: %s\n' "$destino_testigo"

identidad_nueva=$(identidad "$destino_testigo")

# El corazón del asunto: un directorio lleno de enlaces duros tiene todos los ficheros en su sitio
# y no ha separado nada. Si el inodo coincide, atlas sigue leyendo la identidad de kratos.
if [[ -e "$directorio_origen/$testigo" ]]; then
  identidad_origen=$(identidad "$directorio_origen/$testigo")
  if [[ $identidad_nueva == "$identidad_origen" ]]; then
    fallo_comprobacion "el testigo nuevo comparte inodo con el origen ($identidad_nueva): es EL MISMO FICHERO, no se separó nada"
  fi
  printf '  [ok] inodo distinto del origen: %s != %s\n' "$identidad_nueva" "$identidad_origen"
fi

if [[ -n $comparar_con ]]; then
  [[ -e $comparar_con ]] || fallo_comprobacion "no existe la ruta con la que comparar: $comparar_con"
  identidad_vecina=$(identidad "$comparar_con")
  if [[ $identidad_nueva == "$identidad_vecina" ]]; then
    fallo_comprobacion "el testigo nuevo comparte inodo con $comparar_con ($identidad_nueva): los dos alias siguen leyendo el mismo fichero"
  fi
  printf '  [ok] inodo distinto del alias que compartía: %s != %s (%s)\n' "$identidad_nueva" "$identidad_vecina" "$comparar_con"
else
  printf '  [--] sin --comparar-con: NO se comprobó contra el alias que compartía el fichero\n'
fi

# Cada copia declarada tiene que haber llegado. Se comprueba la que se pidió, no la que se supone.
for ((i = 0; i < numero_copias; i++)); do
  [[ -e ${copia_destino[$i]} ]] \
    || fallo_comprobacion "la copia declarada no llegó al destino: ${copia_destino[$i]}"
done
printf '  [ok] llegaron las %s copias declaradas\n' "$numero_copias"

# EL `.claude.json`. Que exista no basta: un fichero truncado o un `{}` arrancan igual de bien y
# dejan al alias sin una sola herramienta. Se dice CUÁNTOS servidores trae para poder compararlo
# con lo que el alias tenía.
destino_claude_json="$directorio_destino/.claude.json"
if [[ $variable == CLAUDE_CONFIG_DIR ]]; then
  [[ -s $destino_claude_json ]] \
    || fallo_comprobacion "falta (o está vacío) $destino_claude_json — CLAUDE_CONFIG_DIR mueve TAMBIÉN ese fichero y con él TODOS los MCP del alias; sin él arranca sin un solo error y sin ninguna herramienta"
  if ! mcp=$(python3 -c '
import json, sys
try:
    documento = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as error:
    sys.exit(f"ilegible: {error}")
if not isinstance(documento, dict):
    sys.exit("no es un objeto JSON")
print(len(documento.get("mcpServers") or {}))
' "$destino_claude_json" 2>&1); then
    fallo_comprobacion ".claude.json llegó pero no se puede leer ($mcp): un fichero a medias arranca igual y deja al alias sin MCP"
  fi
  printf '  [ok] .claude.json llegó y trae %s servidores mcpServers\n' "$mcp"
  if [[ $mcp == 0 ]]; then
    printf '  [!!] ATENCIÓN: 0 servidores MCP. Si el alias tenía herramientas, esto es la pérdida silenciosa.\n'
  fi
fi

printf '\nRESULTADO: separación aplicada y COMPROBADA para %s.\n' "$alias_nombre"
printf 'Falta el último paso, que no hace este guion: exportarle %s=%s al alias\n' "$variable" "$directorio_destino"
printf '(encender CONFIG_POR_ALIAS=1 en su .env y reiniciarlo). Hasta que eso ocurra el alias sigue\n'
printf 'leyendo el directorio viejo y NADA de esto le afecta.\n'
imprimir_reversa
