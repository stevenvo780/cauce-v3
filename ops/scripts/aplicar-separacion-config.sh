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
import json, pathlib, re, sys

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
if not isinstance(plan["borrados"], list) or plan["borrados"]:
    sys.exit(
        "el plan trae borrados y este ejecutor no borra NADA: el directorio de origen es la "
        f"reversa. Borrados pedidos: {plan['borrados']}"
    )

def ruta_canonica(valor, etiqueta):
    if (
        not isinstance(valor, str)
        or not valor.startswith("/")
        or valor == "/"
        or valor.endswith("/")
        or "//" in valor
        or "\0" in valor
        or any(parte in ("", ".", "..") for parte in valor.split("/")[1:])
        or str(pathlib.PurePosixPath(valor)) != valor
    ):
        sys.exit(f"{etiqueta} tiene que ser una ruta absoluta canónica")
    return valor

alias = plan["alias"]
arnes = plan["arnes"]
contratos = {
    "codex": ("CODEX_HOME", ".codex", "AGENTS.md", {
        "AGENTS.md": ("fichero", True),
        "config.toml": ("enlace", True),
        "auth.json": ("enlace", True),
    }),
    "claude": ("CLAUDE_CONFIG_DIR", ".claude", "CLAUDE.md", {
        "CLAUDE.md": ("fichero", True),
        ".claude.json": ("enlace", True),
        ".credentials.json": ("enlace", True),
        "settings.json": ("enlace", False),
    }),
}
if not isinstance(alias, str) or re.fullmatch(r"[a-z][a-z0-9-]*", alias) is None:
    sys.exit("alias inválido")
if arnes not in contratos:
    sys.exit("arnés inválido")
variable_esperada, directorio_arnes, testigo_esperado, operaciones_esperadas = contratos[arnes]
if plan["variable"] != variable_esperada or plan["testigo"] != testigo_esperado:
    sys.exit("variable o testigo no coincide con el arnés")
if not isinstance(plan["reversa"], str) or any(c in plan["reversa"] for c in ("\0", "\r")):
    sys.exit("reversa inválida")

origen = ruta_canonica(plan["directorioOrigen"], "directorioOrigen")
destino = ruta_canonica(plan["directorioDestino"], "directorioDestino")
sufijo = f"/.local/share/cauce-v3/config/{alias}/{directorio_arnes}"
if not destino.endswith(sufijo) or destino == sufijo:
    sys.exit("directorioDestino no es el perfil persistente exacto del alias")
if destino == origen or destino.startswith(origen + "/") or origen.startswith(destino + "/"):
    sys.exit("origen y destino se solapan")

copias = plan["copias"]
if not isinstance(copias, list) or not copias:
    sys.exit("el plan no trae ninguna copia")

vistos = set()
for copia in copias:
    if not isinstance(copia, dict):
        sys.exit("cada operación tiene que ser un objeto")
    tipo = copia.get("tipo")
    ruta_origen = ruta_canonica(copia.get("origen"), "origen de copia")
    ruta = ruta_canonica(copia.get("destino"), "destino de copia")
    if not isinstance(copia.get("obligatorio"), bool):
        sys.exit("obligatorio tiene que ser booleano")
    try:
        relativo = pathlib.PurePosixPath(ruta).relative_to(pathlib.PurePosixPath(destino))
    except ValueError:
        sys.exit(f"la copia a {ruta} cae fuera del perfil exacto")
    if len(relativo.parts) != 1:
        sys.exit(f"la copia a {ruta} no es un destino directo exacto del perfil")
    nombre = relativo.parts[0]
    if nombre in vistos:
        sys.exit(f"el plan duplica el destino {nombre}")
    vistos.add(nombre)
    esperado = operaciones_esperadas.get(nombre)
    if esperado is None or (tipo, copia["obligatorio"]) != esperado:
        sys.exit(f"operación inesperada o incompleta para {nombre}")
    if nombre == testigo_esperado and ruta_origen != f"{origen}/{testigo_esperado}":
        sys.exit("el testigo no sale del directorioOrigen exacto")
    if nombre in {"config.toml", "auth.json", ".credentials.json", "settings.json"}:
        if ruta_origen != f"{origen}/{nombre}":
            sys.exit(f"el origen de {nombre} no coincide con directorioOrigen")
    if nombre == ".claude.json":
        parent = str(pathlib.PurePosixPath(origen).parent)
        if ruta_origen not in {f"{origen}/.claude.json", f"{parent}/.claude.json"}:
            sys.exit("el origen de .claude.json no corresponde al perfil actual")
if vistos != set(operaciones_esperadas):
    faltan = sorted(set(operaciones_esperadas) - vistos)
    sys.exit("el plan omite operaciones exactas: " + ",".join(faltan))

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

# Valida fuentes y publica por descriptores relativos a directorios abiertos con O_NOFOLLOW. Así
# `dest/../victim`, un componente symlink o dos operaciones sobre el mismo nombre fallan antes de
# escribir; ninguna resolución tardía de `cp`, `mkdir` o `ln` puede escapar del perfil autorizado.
aplicar_seguro() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, secrets, stat, sys

def fallo_limpio(_kind, error, _traceback):
    print(str(error) or "operación de filesystem rechazada", file=sys.stderr)

sys.excepthook = fallo_limpio

plan = json.loads(sys.argv[1])
solo_verificar = sys.argv[2] == "true"
rehacer = sys.argv[3] == "true"
destino = plan["directorioDestino"]

def abrir_directorio(ruta, *, crear=False):
    actual = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for componente in ruta.split("/")[1:]:
            try:
                siguiente = os.open(
                    componente,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=actual,
                )
            except FileNotFoundError:
                if not crear:
                    raise
                os.mkdir(componente, 0o700, dir_fd=actual)
                os.fsync(actual)
                siguiente = os.open(
                    componente,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=actual,
                )
            os.close(actual)
            actual = siguiente
        return actual
    except BaseException:
        os.close(actual)
        raise

def abrir_fuente(ruta):
    parent, nombre = ruta.rsplit("/", 1)
    parent_fd = abrir_directorio(parent)
    try:
        fd = os.open(nombre, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    details = os.fstat(fd)
    if not stat.S_ISREG(details.st_mode):
        os.close(fd)
        raise RuntimeError("una fuente no es un fichero regular directo")
    return fd, details

def identidad_fichero(details):
    return (
        details.st_dev, details.st_ino, details.st_mode, details.st_nlink,
        details.st_uid, details.st_gid, details.st_size,
        details.st_mtime_ns, details.st_ctime_ns,
    )

fuentes = []
try:
    # Preflight completo antes de crear un solo componente del destino.
    for operacion in plan["copias"]:
        try:
            fd, details = abrir_fuente(operacion["origen"])
        except FileNotFoundError:
            if operacion["obligatorio"]:
                nombre = operacion["origen"].rsplit("/", 1)[-1]
                raise RuntimeError(f"un origen obligatorio no existe: {nombre}") from None
            fuentes.append(None)
            continue
        fuentes.append((fd, details))

    if solo_verificar:
        destino_fd = abrir_directorio(destino)
        try:
            details = os.fstat(destino_fd)
            if details.st_uid != os.geteuid() or details.st_mode & 0o022:
                raise RuntimeError("el directorio destino tiene ownership o modo inseguros")
        finally:
            os.close(destino_fd)
        raise SystemExit(0)

    parent, nombre_destino = destino.rsplit("/", 1)
    parent_fd = abrir_directorio(parent, crear=True)
    try:
        try:
            existing = os.stat(nombre_destino, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            os.mkdir(nombre_destino, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        else:
            if not rehacer:
                raise RuntimeError("el destino ya existe y no se pidió --rehacer")
            if not stat.S_ISDIR(existing.st_mode) or stat.S_ISLNK(existing.st_mode):
                raise RuntimeError("el destino existente no es un directorio directo")
        destino_fd = os.open(
            nombre_destino,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )
    finally:
        os.close(parent_fd)
    try:
        dest_details = os.fstat(destino_fd)
        if dest_details.st_uid != os.geteuid() or dest_details.st_mode & 0o022:
            raise RuntimeError("el directorio destino tiene ownership o modo inseguros")
        # Rehacer también es fail-closed: validar TODOS los tipos antes de reemplazar el primero
        # evita dejar una publicación parcialmente nueva porque el último nombre era un symlink o
        # directorio inesperado. Una fuente opcional ausente tampoco puede bendecir un destino
        # viejo que ya no representa el plan.
        for operacion, fuente in zip(plan["copias"], fuentes, strict=True):
            nombre = operacion["destino"].rsplit("/", 1)[1]
            try:
                current = os.stat(nombre, dir_fd=destino_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if fuente is None:
                raise RuntimeError("un destino opcional obsoleto requiere inspección")
            if not rehacer:
                raise RuntimeError("un destino exacto ya existe")
            if operacion["tipo"] == "fichero" and not stat.S_ISREG(current.st_mode):
                raise RuntimeError("un fichero destino existente tiene tipo ambiguo")
            if operacion["tipo"] == "enlace" and not stat.S_ISLNK(current.st_mode):
                raise RuntimeError("un enlace destino existente tiene tipo ambiguo")
        for operacion, fuente in zip(plan["copias"], fuentes, strict=True):
            if fuente is None:
                continue
            source_fd, source_details = fuente
            nombre = operacion["destino"].rsplit("/", 1)[1]
            temporal = f".{nombre}.cauce-{os.getpid()}-{secrets.token_hex(8)}"
            try:
                if operacion["tipo"] == "fichero":
                    output = os.open(
                        temporal,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                        stat.S_IMODE(source_details.st_mode) & 0o700 or 0o600,
                        dir_fd=destino_fd,
                    )
                    try:
                        while True:
                            chunk = os.read(source_fd, 65536)
                            if not chunk:
                                break
                            view = memoryview(chunk)
                            while view:
                                written = os.write(output, view)
                                if written <= 0:
                                    raise RuntimeError("escritura incompleta")
                                view = view[written:]
                        if identidad_fichero(os.fstat(source_fd)) != identidad_fichero(source_details):
                            raise RuntimeError("una fuente cambió durante la copia")
                        os.fsync(output)
                    finally:
                        os.close(output)
                else:
                    os.symlink(operacion["origen"], temporal, dir_fd=destino_fd)

                os.replace(temporal, nombre, src_dir_fd=destino_fd, dst_dir_fd=destino_fd)
                os.fsync(destino_fd)
            finally:
                try:
                    os.unlink(temporal, dir_fd=destino_fd)
                except FileNotFoundError:
                    pass
    finally:
        os.close(destino_fd)
finally:
    for fuente in fuentes:
        if fuente is not None:
            os.close(fuente[0])
PY
}

# ---------------------------------------------------------------------------
# Aplicación.
# ---------------------------------------------------------------------------
if ! error_aplicacion=$(aplicar_seguro "$plan_json" "$solo_verificar" "$rehacer" 2>&1); then
  morir "publicación segura rechazada${error_aplicacion:+: $error_aplicacion}"
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
  if [[ ! -e ${copia_origen[$i]} && ${copia_obligatoria[$i]} == 0 ]]; then
    continue
  fi
  [[ -e ${copia_destino[$i]} ]] \
    || fallo_comprobacion "la copia declarada no llegó al destino: ${copia_destino[$i]}"
  if [[ ${copia_tipo[$i]} == enlace ]]; then
    [[ -L ${copia_destino[$i]} ]] \
      || fallo_comprobacion "el destino debía ser un enlace, no una copia: ${copia_destino[$i]}"
    origen_real=$(readlink -f -- "${copia_origen[$i]}")
    destino_real=$(readlink -f -- "${copia_destino[$i]}")
    [[ -n $origen_real && $destino_real == "$origen_real" ]] \
      || fallo_comprobacion "el enlace no conserva la fuente única autorizada: ${copia_destino[$i]}"
  fi
done
printf '  [ok] llegaron las %s copias declaradas\n' "$numero_copias"

# EL `.claude.json`. Que exista no basta: un fichero truncado, un mapa vacío o entradas sin
# transporte arrancan sin proporcionar herramientas. Se exige un mapa no vacío y cada servidor
# debe declarar un comando local o una URL remota mínimamente bien formada.
destino_claude_json="$directorio_destino/.claude.json"
if [[ $variable == CLAUDE_CONFIG_DIR ]]; then
  [[ -s $destino_claude_json ]] \
    || fallo_comprobacion "falta (o está vacío) $destino_claude_json — CLAUDE_CONFIG_DIR mueve TAMBIÉN ese fichero y con él TODOS los MCP del alias; sin él arranca sin un solo error y sin ninguna herramienta"
  if ! mcp=$(python3 -c '
import json, sys
from urllib.parse import urlsplit
try:
    documento = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as error:
    sys.exit(f"ilegible: {error}")
if not isinstance(documento, dict):
    sys.exit("no es un objeto JSON")
servidores = documento.get("mcpServers")
if not isinstance(servidores, dict) or not servidores:
    sys.exit("mcpServers debe ser un objeto no vacío")
for nombre, servidor in servidores.items():
    if not isinstance(nombre, str) or not nombre or any(c.isspace() for c in nombre):
        sys.exit("mcpServers contiene un nombre inválido")
    if not isinstance(servidor, dict):
        sys.exit("mcpServers contiene una entrada que no es objeto")
    comando = servidor.get("command")
    url = servidor.get("url")
    if (comando is None) == (url is None):
        sys.exit("mcpServers contiene una entrada ambigua o sin transporte")
    if comando is not None:
        if not isinstance(comando, str) or not comando.strip() or "\0" in comando:
            sys.exit("mcpServers contiene un comando inválido")
        argumentos = servidor.get("args", [])
        entorno = servidor.get("env", {})
        if (not isinstance(argumentos, list)
                or any(not isinstance(item, str) or "\0" in item for item in argumentos)
                or not isinstance(entorno, dict)
                or any(not isinstance(key, str) or not key or "\0" in key
                       or not isinstance(value, str) or "\0" in value
                       for key, value in entorno.items())):
            sys.exit("mcpServers contiene argumentos o entorno inválidos")
    else:
        if (not isinstance(url, str) or not url or url != url.strip()
                or any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7f
                       for character in url)):
            sys.exit("mcpServers contiene una URL inválida")
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            sys.exit("mcpServers contiene una URL inválida")
        if (parsed.scheme not in ("http", "https")
                or not parsed.netloc
                or parsed.hostname is None
                or parsed.username is not None
                or parsed.password is not None
                or "#" in url
                or parsed.netloc.endswith(":")):
            sys.exit("mcpServers contiene una URL inválida")
        if port is not None and not 1 <= port <= 65535:
            sys.exit("mcpServers contiene una URL inválida")
        if servidor.get("type", "http") not in ("http", "sse"):
            sys.exit("mcpServers contiene un transporte remoto inválido")
print(len(servidores))
' "$destino_claude_json" 2>&1); then
    fallo_comprobacion ".claude.json llegó pero no se puede leer ($mcp): un fichero a medias arranca igual y deja al alias sin MCP"
  fi
  printf '  [ok] .claude.json llegó y trae %s servidores mcpServers\n' "$mcp"
fi

printf '\nRESULTADO: separación aplicada y COMPROBADA para %s.\n' "$alias_nombre"
printf 'Falta el último paso, que no hace este guion: exportarle %s=%s al alias\n' "$variable" "$directorio_destino"
printf '(encender CONFIG_POR_ALIAS=1 en su .env y reiniciarlo). Hasta que eso ocurra el alias sigue\n'
printf 'leyendo el directorio viejo y NADA de esto le afecta.\n'
imprimir_reversa
