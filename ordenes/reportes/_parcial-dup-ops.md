# Parcial: duplicados copy-paste en `ops/`, `scripts/` y `deploy/`

Sector: `ops/**/*.py|sh|mjs`, `scripts/**`, `deploy/**/*.sh|mjs`. Zona NADIE = `deploy/` y `packages/store/migrations/**` (no se reportan duplicados ahí como accionables — solo se mencionan). Lectura pura, sin tocar nada; detector en `/tmp/opencode/dup-ops.mjs` y `/tmp/opencode/dup-ops-ext.mjs`.

## Método

1. Detector de ventanas (`/tmp/opencode/dup-ops.mjs`): normaliza cada fichero (quita `#` y `//`, colapsa espacios, descarta líneas vacías dentro de la ventana), genera todas las ventanas de N líneas, agrupa por SHA-1, emite solo grupos con ≥2 ficheros. Trata por separado `.py`, `.sh`, `.mjs`. Probado con N=6 y N=10. Resultado bruto: 124 grupos N=6 y 43 grupos N=10 sobre 159 ficheros (68 `.py`, 39 `.sh`, 52 `.mjs`).
2. Detector de bash sin extensión (`/tmp/opencode/dup-ops-ext.mjs`): para `ops/cli/*.sh-less`, busca shebang `#!.*sh` y los cruza con todo el árbol. Detectó 6 ficheros y 0 duplicados N=6 automáticos — por eso `cauce-portatil` se cazó a mano contra `cauce-envoltorio-local.sh`.
3. Verificación a mano leyendo ambos lados de cada grupo. Falsos positivos descartados: shebangs, `set -euo pipefail`, `umask`, `from __future__ import annotations`, shebang+encabezado trivial de test, imports aislados (`json`, `os`, etc.) sin cuerpo funcional.
4. UMBRAL EFECTIVO: bloques de ≥6 líneas **funcionales** idénticos tras normalizar, en ≥2 ficheros distintos. Se exige cita textual de ambos lados.

Ordenado por `ocurrencias × líneas` descendente. Total líneas duplicadas (bloques compartidos, descontando el "original" — para N ficheros con L líneas compartidas se cuentan L×(N-1) líneas copia): **~1180 líneas**.

---

### G-1 — `cauce` (CLI de kratos) duplicado literal — 2 ocurrencias — 565 líneas
- `ops/cli/cauce:1-565`
- `ops/guardias/cauce-kratos.sh:1-568`

Diferencias: solo dos bloques de comentarios divergen
- `ops/cli/cauce:173-174` vs `ops/guardias/cauce-kratos.sh:174-177` (comentario del stateDirectory, 2 líneas vs 4 líneas)
- `ops/cli/cauce:13` arranca con `set -uo pipefail`; `cauce-kratos.sh:14` (1 línea después) — la cabecera de comentarios de `cauce-kratos.sh` ocupa una línea más.

CITA (cuerpo idéntico a partir de L22/L23 en ambos):
```
alias_info() {  # $1=alias -> "tenant\troom\tcontenedor\tusuario\thome\tstate\tharness"
  PYTHONDONTWRITEBYTECODE=1 python3 "$OPS/scripts/container-alias-query.py" "$1" 2>/dev/null
}
todos_los_alias() {
  for f in "$CONFIG"/*.env; do
    [ -e "$f" ] || continue; basename "$f" .env
  done | sort
}
```
(`ops/cli/cauce:22-29` y `ops/guardias/cauce-kratos.sh:23-30`).

```
adaptador_activo() {
  local e
  e=$(systemctl --user is-active "cauce-v3-container-$1.service" 2>/dev/null)
  if [ "$e" != active ] && systemctl --user cat "cauce-v3-host-$1.service" >/dev/null 2>&1; then
    systemctl --user is-active "cauce-v3-host-$1.service" 2>/dev/null
  else
    printf '%s\n' "$e"
  fi
}
```
(`ops/cli/cauce:32-42` y `ops/guardias/cauce-kratos.sh:33-43`).

**Diferencia material**: `cauce-kratos.sh:1-15` lleva un comentario explicativo de 11 líneas más sobre la instalación y la historia ("Vivió catorce meses sólo en el home de stev…"); `ops/cli/cauce:1-12` lo tiene más resumido ("ESTE FICHERO ES LA FUENTE. Se instala en kratos…"). El cuerpo funcional desde L25/L29 hasta el final es idéntico en ambos.

HOGAR ÚNICO SUGERIDO: `ops/cli/cauce` (ya documenta "ESTE FICHERO ES LA FUENTE. Se instala en kratos…"). `ops/guardias/cauce-kratos.sh` debería pasar a ser un shim de 5 líneas tipo `ops/guardias/cauce-huerfanas.sh` (L1-15 ya hace esto con su primo `cauce-huerfanas`):
```
#!/usr/bin/env bash
exec "${BASH_SOURCE[0]%/*}/../cli/cauce" "$@"
```
Riesgo ALTO: ambos binarios se invocan en máquinas distintas (portátil vs kratos) y ya divergieron en el comentario del stateDirectory (`ops/cli/cauce:173-174` dice "El stateDirectory viene de container-alias-query.py"; `cauce-kratos.sh:174-177` añade la matización "no se deduce del HOME… Medido el 2026-07-31"). Si uno se reescribe y el otro no, el panel tmux puede volver a mentir.

DUEÑO: `ops/cli/**` y `ops/guardias/**` = **Claude** (per protocolo fila 30).

---

### G-2 — `cauce-portatil` == `cauce-envoltorio-local.sh` — 2 ocurrencias — 115 líneas
- `ops/cli/cauce-portatil:1-115`
- `ops/guardias/cauce-envoltorio-local.sh:1-120`

El detector de extensiones no los cazó porque `cauce-portatil` no tiene `.sh`. Verificado a mano: la sub-rutina `probar` (la que publica una entrega real al gateway y mira el panel tmux) es **bit-a-bit idéntica** entre ambos, salvo que `cauce-envoltorio-local.sh` carga 5 líneas de cabecera extra antes (comentario de 5 líneas + `set -uo pipefail` + `HOST=` + `REMOTO=`).

CITA (bloque común `probar`, `cauce-portatil:24-43` ↔ `cauce-envoltorio-local.sh:29-48`):
```
if [ "${1:-}" = probar ]; then
  shift
  [ $# -ge 1 ] || { echo "uso: cauce probar <alias>" >&2; exit 2; }
  A=$1
  TEN=$(ssh -o BatchMode=yes "$HOST" "bash -lc $(printf '%q' "python3 \$HOME/.local/share/cauce-v3/ops/scripts/container-alias-query.py $A")" 2>/dev/null | cut -f1)
  [ -n "$TEN" ] || { echo "alias desconocido: $A" >&2; exit 2; }
  MARCA="PROBAR-$(tr -dc a-f0-9 </dev/urandom | head -c 8)"
  echo "  publicando entrega real a $A (tenant $TEN) con marca $MARCA"
  RESP=$(ssh -o BatchMode=yes agora-storage "cat > /tmp/cauce-probar.json && curl -sS -k \
      --cert /etc/cauce-v3/pki/console-client.crt --key /etc/cauce-v3/pki/console-client.key \
      -H 'content-type: application/json' -H 'x-cauce-operator: steven' \
      -X POST https://100.64.0.6:8443/v3/messages --data @/tmp/cauce-probar.json; \
      rm -f /tmp/cauce-probar.json" <<JSON
{"room_id":"grp.steven","recipients":[{"tenant_id":"$TEN","alias":"$A"}],"body":{"text":"Prueba de vida de Cauce. Responde UNICAMENTE con: $MARCA"},"idempotency_key":"probar-$A-$MARCA","lane":"interactive","priority":5}
JSON
)
  ID=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["delivery_ids"][0])
except Exception: pass' 2>/dev/null)
  [ -n "$ID" ] || { echo "  el gateway rechazo la publicacion:"; echo "  $RESP"; exit 1; }
```

Bloques posteriores (`soltar`, ssh con TTY condicional, `printf %q` por argumento) idénticos también.

HOGAR ÚNICO SUGERIDO: dejar `ops/cli/cauce-portatil` como fuente y reducir `ops/guardias/cauce-envoltorio-local.sh` a shim (`exec "$REPO_CLI/cauce-portatil" "$@"`), igual que ya hace `cauce-huerfanas.sh:5-13`.

DUEÑO: **Claude** (ambos sectores son suyos).

RIESGO: MEDIO — divergencia detectada SOLO en el comentario de cabecera (5 líneas). El binario se llama desde dos contextos distintos (portátil vs guardia kratos) y tocar uno sin tocar el otro ya ha pasado (es la razón por la que `cauce-huerfanas.sh` es shim ahora).

---

### G-3 — Probes HTTP de `deploy/` (NADIE) — 4 ocurrencias — 50 líneas
- `deploy/liveness-probe.mjs:67-117` (`fetchHealthDocument`)
- `deploy/readiness-probe.mjs:79-129` (cuerpo `try` con `await loadDatabaseUrlFile(); await assertProductionPostgresTls(timeoutMs); const url = …`)
- `deploy/unix-readiness-probe.mjs:14-34` (idéntica, variante por socketPath)
- `deploy/local-readiness-probe.mjs:18-46` (idéntica, sin TLS, con 4_096 byte cap en vez de 65_536)

El detector agrupó las 4 en `aa3ced9e` (N=6) y las 3 `http(s)Request` en `cec08ab7`/`8b7b8312` (N=10, occ=3). El bloque común es `new Promise((resolve, reject) => { … response.on('data', (chunk) => { size += chunk.length; if (size > MAX) response.destroy(...); else chunks.push(chunk); }); response.once('error', reject); response.on('end', () => { if (!response.statusCode || statusCode<200 || statusCode>=300) { reject(new Error(\`HTTP ${statusCode ?? 0}\`)); return; } resolve(Buffer.concat(chunks).toString('utf8')); }); … }); request.once('error', reject); request.end();`.

CITA (`deploy/liveness-probe.mjs:97-114` ↔ `deploy/readiness-probe.mjs:110-127`):
```
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maximumBodyBytes) response.destroy(new Error('health response is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    call.once('error', reject);
    call.end();
```

Diferencias:
- `local-readiness-probe.mjs:32` usa `4_096` como `maximumBodyBytes` en vez de `65_536`
- `readiness-probe.mjs:89-93` añade comprobaciones extra (mTLS, `CAUCE_AUTH_PROVIDER=mtls`)
- `unix-readiness-probe.mjs:15` cambia el target a `socketPath` y se traga el path

HOGAR ÚNICO SUGERIDO: NO TOCAR (`deploy/` es zona NADIE; FASE 3). Reportado porque es exactamente el caso de `@import×11` pero en tooling: 4 copias de la misma rutina de fetch con divergencias leves.

DUEÑO: **NADIE** (fila 32 del protocolo: "hasta FASE 3").

RIESGO: ALTO — ya divergieron (cuerpo de respuesta cap, mTLS guard, socket path). Si el gateway cambia `Content-Type` o formato de error, 3 de los 4 probes se quedan mintiendo hasta FASE 3.

---

### G-4 — `open_absolute_directory` + `open_regular_at` + `file_identity` + `assert_private_regular` (3-way) — 3 ocurrencias — ~40 líneas
- `ops/scripts/pin-container-release.py:58-122` (funciones `open_absolute_directory`, `open_regular_at`, `assert_config_file`, `file_identity`; más la lógica de `atomic_replace` en L332-368)
- `ops/scripts/update_alias_lib.py:158-226` (mismas 4 funciones, mensajes en español en vez de inglés)
- `ops/container-runtime/cauce-container-runtime.py:79-116` (`open_directory`, con creación opcional y verificación de symlinks — más elaborada)

CITA (`ops/scripts/pin-container-release.py:61-75` ↔ `ops/scripts/update_alias_lib.py:160-174`):
```python
    validate_absolute(path, label)
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in os.fspath(path).split("/")[1:]:
            following = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=current,
            )
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise
```

Diferencias entre los dos `ops/scripts/**`:
- `update_alias_lib.py:178-185` (`assert_secure_directory`) acepta un `mode` opcional; `pin-container-release.py:78-84` (`assert_owned_secure_directory`) no.
- `update_alias_lib.py` usa mensajes `ConfigUpdateError` en español; `pin-container-release.py` usa `PinError` en inglés. Mismas reglas de validación, distinto vocabulario.

`cauce-container-runtime.py:79-116` cubre lo mismo pero ampliado: maneja `create_below`, `ELOOP`/`ENOTDIR`, fija `uid`/`gid`/`0o700`. Es **una generalización honesta** de las dos anteriores — no debería eliminarse, pero las dos primeras sí pueden compartir un helper.

HOGAR ÚNICO SUGERIDO: subir las dos versiones minimalistas a `ops/scripts/fs_lib.py` (`open_absolute_directory`, `open_regular_at`, `file_identity`) y dejar `cauce-container-runtime.py` como tercera implementación más completa (el SSoT ya no cabe en la misma firma; o se hace `cauce-container-runtime.py` consumidor de la `fs_lib`, o se acepta el delta). También `ops/scripts/update-alias-config.py:166-203` (`atomic_replace`) reutiliza las mismas funciones — debería importar de la lib, no duplicar.

DUEÑO: `ops/scripts/**` = **Codex** (fila 29); `ops/container-runtime/**` = **Claude** (fila 30).

RIESGO: MEDIO — los mensajes ya están en idiomas distintos (inglés en pin, español en update_alias), un bug de seguridad futuro (p. ej. `O_DIRECTORY` no soportado en alguna plataforma) probablemente se arregle solo en uno.

---

### G-5 — `assert_secure_file` + `assert_secure_directory` + `die` + `docker_control` + `valid_alias` + `valid_absolute_path` (helpers de bash repetidos) — 2 ocurrencias — ~50 líneas
- `ops/pty-agent/cauce-pty-launcher.sh:26-72` (incluye `die_transient` y `docker_control`)
- `ops/scripts/container-adapter-supervisor.sh:37-127` (incluye `config_por_alias_*` adicional)

CITA (`cauce-pty-launcher.sh:57-71` ↔ `container-adapter-supervisor.sh:112-126`):
```bash
assert_secure_file() {
  local path=$1 expected_mode=$2 label=$3 owner mode
  [[ -f $path && ! -L $path ]] || die "$label must be a regular non-symlink file"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  [[ $owner == "$EUID" && $mode == "$expected_mode" ]] || die "$label must be owned by the launcher user with mode $expected_mode"
}

assert_secure_directory() {
  local path=$1 label=$2 owner mode numeric
  [[ -d $path && ! -L $path ]] || die "$label must be a non-symlink directory"
  owner=$(stat -c '%u' "$path") || die "cannot inspect $label"
  mode=$(stat -c '%a' "$path") || die "cannot inspect $label"
  numeric=$((8#$mode))
  [[ $owner == "$EUID" && $((numeric & 8#022)) -eq 0 ]] || die "$label must be owned by the launcher user and not group/world writable"
}
```

Diferencias:
- `container-adapter-supervisor.sh:108-110` introduce `safe_owner_uid()` (wrapper de `$EUID` para tests); `cauce-pty-launcher.sh` usa `$EUID` directo.
- Mensaje final de error: uno dice "owned by the launcher user", el otro "have the required owner and mode".

HOGAR ÚNICO SUGERIDO: `ops/scripts/assert-secure.sh` (sourced) o incluir en el futuro `ops/scripts/lib.sh` cuando exista. `die`, `docker_control`, `valid_alias`, `valid_absolute_path` también idénticas (`cauce-pty-launcher.sh:26-50` ↔ `container-adapter-supervisor.sh:37-67`).

DUEÑO: `ops/pty-agent/**` = **Gemini** (fila 28); `ops/scripts/**` = **Codex** (fila 29).

RIESGO: MEDIO — divergencia en mensajes y en el uso de `safe_owner_uid`. Si uno decide usar `set -u` estricto y el otro no, los errores se camuflarán distinto.

---

### G-6 — Bloque de hardening systemd (NoNewPrivileges…CapabilityBoundingSet) — 2 ocurrencias — 17 líneas
- `ops/scripts/generate-units.py:74-89`
- `ops/scripts/generate-container-units.py:113-130` (dentro de la plantilla `system_unit`)

CITA (`generate-units.py:74-89`):
```
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
```

Diferencia única: `RestrictAddressFamilies=AF_UNIX` (generate-container-units) vs `…AF_UNIX AF_INET AF_INET6` (generate-units). El bloque se propaga a `ops/generated/systemd/cauce-v3-alias-*.service` y `ops/generated/container-systemd/rootless/*` — los 14+1 ficheros generados son **salida esperada**, no se reportan como duplicados (regla: solo fuente).

HOGAR ÚNICO SUGERIDO: constante `SYSTEMD_HARDENING_LINES` en `ops/scripts/systemd_hardening.py` (o `generate-systemd-common.py` si se crea) que ambos generadores importen. Si `RestrictAddressFamilies` debe divergir, que sea un parámetro.

DUEÑO: **Codex** (ambos en `ops/scripts/**`).

RIESGO: BAJO — son strings literales, no lógica. Pero si se añade (p. ej.) `MemoryDenyWriteExecute=true` en uno y se olvida en el otro, las units vivas (`ops/generated/systemd/cauce-v3-alias-*.service`) pueden ofrecer superficies de ataque distintas a igualdad de rol.

---

### G-7 — `atomic_write` / `_atomic_write` (tempfile + fsync + replace atómico) — 2 ocurrencias — 12 líneas
- `ops/scripts/generate-container-units.py:74-86` (`atomic_write`)
- `ops/scripts/generate-telegram-config.py:724-736` (`_atomic_write`)

CITA (`generate-container-units.py:74-86`):
```python
def atomic_write(destination: pathlib.Path, body: str, mode: int = 0o644) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
```

Diferencias: NINGUNA funcional — solo el nombre (`atomic_write` vs `_atomic_write`, el guion bajo es por visibilidad de "interno").

HOGAR ÚNICO SUGERIDO: `ops/scripts/atomic_write.py` o añadir a `ops/scripts/fs_lib.py` (ver G-4). Mover el parámetro `mode=0o644` por defecto.

DUEÑO: **Codex**.

RIESGO: BAJO — idénticos al carácter. Si se añade (p. ej.) `os.fsync(parent_dir_fd)` para fsync del directorio, se hará en uno y se olvidará en el otro.

---

### G-8 — `waitUntil(operation, timeoutMs)` helper — 2 ocurrencias — 12 líneas
- `ops/harness/contract-runner.mjs:127-138`
- `ops/harness/runner.mjs:317-328`

CITA (`contract-runner.mjs:127-138`):
```js
async function waitUntil(operation, timeoutMs = wsTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(30);
  }
  throw lastError || new Error(`condition timeout after ${timeoutMs}ms`);
}
```

Idéntica línea por línea en `runner.mjs:317-328`. La constante `wsTimeoutMs` (línea 32 / 29) también se duplica, con defaults distintos (`5000` vs `8000`).

HOGAR ÚNICO SUGERIDO: `ops/harness/wait-until.mjs` exportando `waitUntil` y `sleep` (también duplicada en L33 / L35 — `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`). Ambos ficheros ya importan `path`, `node:url`, etc. — añadir uno más es trivial.

DUEÑO: `ops/harness/**` (test/harness infra del gateway) = **Codex** (fila 29).

RIESGO: BAJO — idénticos, pero el "deadline" usa `Date.now()` con sleep(30). Si en uno se cambia a `setImmediate`-based y en el otro no, los tests tendrán timeouts distintos sin evidencia.

---

### G-9 — Preámbulo de tests `pty-agent/tests/*.py` (imports + `sys.path` + `import cauce_pty_agent`) — 10 ocurrencias — ~10 líneas
- `ops/pty-agent/tests/test_openclaw_dynamic.py:5-12`
- `ops/pty-agent/tests/test_read_governance.py:14-21`
- `ops/pty-agent/tests/test_write_governance_batch.py:6-13`
- `ops/pty-agent/tests/test_write_governance.py:5-13`
- `ops/pty-agent/tests/test_governance_allowlists.py:3-11`
- `ops/pty-agent/tests/test_presencia_home.py` (análoga)
- `ops/pty-agent/tests/test_framing.py` (más corta)
- `ops/pty-agent/tests/test_hkdf.py`
- `ops/pty-agent/tests/test_ticket.py`
- `ops/pty-agent/tests/test_runtime_facts.py`

CITA (`test_openclaw_dynamic.py:5-17` ↔ `test_read_governance.py:14-20`):
```python
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402
```

Difieren solo en el conjunto exacto de imports (algunos meten `hashlib`, `subprocess`, `stat`), pero el bloque `AGENT_DIR = …; sys.path.insert` es idéntico.

HOGAR ÚNICO SUGERIDO: `ops/pty-agent/tests/conftest.py` (para pytest) o un `ops/pty-agent/tests/_prelude.py` que se importe al principio de cada test. `python3 -m unittest discover` ya está documentado como el modo de ejecución (`test_read_governance.py:9-10`); un `conftest.py` no rompe ese flujo.

DUEÑO: `ops/pty-agent/tests/**` = **Gemini** (fila 28).

RIESGO: BAJO — es boilerplate, no lógica. Pero ya está en 10 ficheros; uno más y se convierte en la "infra oficiosa" del paquete.

---

### G-10 — `tenants` / `tenantAgents` / `topology` (mapa tenant→aliases) — 3 ocurrencias — 6 líneas + 1 variante
- `ops/harness/contract-runner.mjs:21-27` (`tenants`)
- `ops/harness/mock-server.mjs:12-18` (`tenantAgents`, idéntico)
- `ops/harness/runner.mjs:128-134` (`topology`, **diverge**: añade 'zeus' a Steven, 'atlas' y 'iza' a Miguel — y reorganiza como `{room, aliases}`)

CITA (`contract-runner.mjs:21-27` ↔ `mock-server.mjs:12-18`):
```js
const tenants = {
  steven: ['jarvis', 'kant', 'socrates', 'argos'],
  miguel: ['kratos', 'janus'],
  isa: ['salva'],
  jhon: ['hegel'],
  pablo: ['dedalo', 'midas', 'seneca', 'vulcano'],
};
```

`runner.mjs:128-134` añade los alias `zeus`, `atlas`, `iza` que faltan en los otros dos:
```js
const topology = {
  Steven: { room: 'grp.steven', aliases: ['argos', 'jarvis', 'kant', 'socrates', 'zeus'] },
  Miguel: { room: 'grp.miguel', aliases: ['atlas', 'iza', 'janus', 'kratos'] },
  Isa: { room: 'grp.isa', aliases: ['salva'] },
  Jhon: { room: 'grp.jhon', aliases: ['hegel'] },
  Pablo: { room: 'grp.pablo', aliases: ['dedalo', 'midas', 'seneca', 'vulcano'] },
};
```

HOGAR ÚNICO SUGERIDO: `ops/harness/fleet.mjs` con la forma completa `{tenant: {room, aliases}}` y `mock-server.mjs` + `contract-runner.mjs` consumen el derivado (lista simple). El `runner.mjs` además consume `room`. Riesgo: el `runner.mjs` ya tiene información extra (alias `zeus`, `atlas`, `iza` que NO están en `contract-runner`/`mock-server`); esos alias **se rompen** en los tests mock/contract sin quejarse. Si se centraliza, hay que decidir cuál es el canon.

DUEÑO: `ops/harness/**` = **Codex** (test/harness tooling).

RIESGO: ALTO — divergencia REAL entre los dos grupos. Si se añade un alias (p. ej. `prometeo` para Isa) y solo se actualiza `runner.mjs`, los contract tests pasan pero la integración real no lo cubre.

---

### G-11 — `boundedInteger(name, fallback, minimum, maximum)` — 2 ocurrencias — 8 líneas
- `ops/scripts/gate-collector.mjs:47-54`
- `ops/scripts/gate-roundtrip-probe.mjs:20-27`

CITA (`gate-collector.mjs:47-54`):
```js
function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
```

Idéntica línea por línea.

HOGAR ÚNICO SUGERIDO: `ops/scripts/env-int.mjs` o añadir a un futuro `ops/scripts/numeric-helpers.mjs`.

DUEÑO: **Codex** (`ops/scripts/**`).

RIESGO: BAJO — idénticas.

---

### G-12 — `redactUrl(value)` helper — 2 ocurrencias — 7 líneas
- `ops/harness/contract-runner.mjs:449-455`
- `ops/harness/runner.mjs:690-696`

CITA (`contract-runner.mjs:449-455`):
```js
function redactUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) if (/token|key|secret|auth/i.test(key)) url.searchParams.set(key, 'REDACTED');
  return url.toString();
}
```

Idéntica carácter por carácter.

HOGAR ÚNICO SUGERIDO: importar desde `ops/harness/wait-until.mjs` (si se crea en G-8) o un `ops/harness/redact.mjs`.

DUEÑO: **Codex** (`ops/harness/**`).

RIESGO: BAJO — pero la regex `token|key|secret|auth` ya está pidiendo un fix (no atrapa `apikey`, `api-key`, `access_token`); si lo arreglan en uno y no en el otro, los logs del contract-test tendrán fugas que el run real no tendrá.

---

### G-13 — `WsClient.next(predicate, timeoutMs)` — 2 ocurrencias — 9 líneas
- `ops/harness/contract-runner.mjs:61-69`
- `ops/harness/runner.mjs:208-216`

CITA (`contract-runner.mjs:61-69`):
```js
  async next(predicate = () => true, timeoutMs = wsTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await sleep(10);
    }
    throw new Error(`WS message timeout after ${timeoutMs}ms`);
  }
```

Diferencias:
- Mensaje de error: `'WS message timeout after ${timeoutMs}ms'` (contract-runner) vs `'WebSocket frame timeout after ${timeoutMs}ms'` (runner).

HOGAR ÚNICO SUGERIDO: `ops/harness/ws-client.mjs` con la clase `WsClient`. Ambas versiones son la misma clase `WsClient`; lo único que cambia es el nombre del timeout-error. Si se añade validación del tamaño del buffer (límite de mensajes encolados), debe hacerse en las dos.

DUEÑO: **Codex** (`ops/harness/**`).

RIESGO: BAJO — pero el error-message distinto significa que un `grep WS message timeout` solo encuentra en uno.

---

### G-14 — Bucle `write_all(payload)` con fsync (helper de escritura privada) — 2 ocurrencias — 6 líneas
- `ops/scripts/dlq_cli.py:158-165` (dentro de `write_atomic` → `parent.mkdir(0o700, …)`, `tempfile.mkstemp(0o600)`, write loop, fsync)
- `ops/scripts/private-postgres-command.py:181-186` (dentro de `write_private` → `os.open(…, O_EXCL|O_CLOEXEC, 0o600)`, write loop, fsync)

CITA (`dlq_cli.py:158-165`):
```python
        payload = canonical_json(value)
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
```

`private-postgres-command.py:181-186`:
```python
        payload = content.encode("utf-8") if isinstance(content, str) else content
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
```

Diferencias: solo el cómputo del payload (json-canónico vs utf-8-encode); el bucle `while offset < len(payload): offset += os.write(...)` es idéntico.

HOGAR ÚNICO SUGERIDO: `write_all(fd, payload)` en `ops/scripts/fs_lib.py` (ver G-4) — recibe `fd` y bytes, devuelve al cerrar.

DUEÑO: **Codex** (`ops/scripts/**`).

RIESGO: BAJO — pero el patrón `while offset < len(payload): offset += os.write(...)` es el tratamiento de `short-write`; si se cambia a `os.writev` o `os.sendfile` en uno y no en el otro, la escritura atómica de evidencia tendrá semántica distinta.

---

### G-15 — Whitelist de tests en `container_ops_digest.py` duplicada en el test que la verifica — 2 ocurrencias — 9 líneas
- `ops/scripts/container_ops_digest.py:29-37` (dentro de `OPERATIONS_SOURCES`)
- `ops/tests/container-ops-evidence.test.mjs:34-42` (dentro de la lista de paths esperados)

CITA (`container_ops_digest.py:29-37` ↔ `container-ops-evidence.test.mjs:34-42`):
```python
"tests/container-supervisor.test.mjs",
"tests/test_container_runtime_reaping.py",
"tests/alias-runner.test.mjs",
"tests/container-cutover.test.mjs",
"tests/container-ops-evidence.test.mjs",
"tests/fake-docker.mjs",
"tests/fake-systemctl.mjs",
"tests/fake-container-supervisor.mjs",
"tests/fake-gate-collector.mjs",
```

Diferencia: `container-ops-evidence.test.mjs:34-42` está dentro de un array JS con `]` al final y comillas distintas (`"`), pero los 9 paths son los mismos. El test verifica que `OPERATIONS.sha256` se mueve cuando uno de estos cambia — duplicar la lista en el test anula la verificación: si añades un path al `.py` pero olvidas añadirlo al test, el test sigue verde mintiendo.

HOGAR ÚNICO SUGERIDO: el test debe importar el `tuple` (o `list`) `OPERATIONS_SOURCES` desde `container_ops_digest` y restar paths triviales (el propio `container-ops-evidence.test.mjs` no debería aparecer). Hoy están duplicados.

DUEÑO: **Codex** (`ops/scripts/**` + `ops/tests/**`).

RIESGO: ALTO — la duplicación literal de la whitelist en su propio test **destruye el propósito del test**: el test pasa si ambas listas están sincronizadas, pero NO prueba que la lista cubra lo que dice cubrir.

---

### G-16 — Sonda `git rev-parse --show-toplevel` — 2 ocurrencias — 6 líneas
- `ops/scripts/source-digest.py:222-227`
- `ops/scripts/container_ops_digest.py:89-94`

CITA (`container_ops_digest.py:89-94`):
```python
        probe = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
        )
```

Idéntica en `source-digest.py:222-227`. La única diferencia es el manejo del `OSError` (uno traga excepción, el otro lanza `SourceDigestError`).

HOGAR ÚNICO SUGERIDO: `git_toplevel(root) -> str | None` en `ops/scripts/git_probe.py` o en `fs_lib.py`.

DUEÑO: **Codex** (`ops/scripts/**`).

RIESGO: BAJO — patrón mecánico.

---

### G-17 — `reap_children` / waitpid loop — 2 ocurrencias — 6 líneas
- `ops/container-runtime/cauce-container-runtime.py:894-899` (dentro de `reap_orphans`)
- `ops/tests/test_container_runtime_zombies.py:33-38` (función `reap_children` auxiliar del test)

CITA (`cauce-container-runtime.py:894-899`):
```python
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
```

`test_container_runtime_zombies.py:33-38`: idéntica, sin indentación interna (es función, no método).

Esta es una **duplicación benigna entre código de producción y test**: el test replica el cuerpo para ejercitar el comportamiento aislado. Se documenta porque a futuro podría haber una divergencia (p. ej. `WCONTINUED`), pero NO se propone hogar único.

DUEÑO: `ops/container-runtime/**` = **Claude** (fila 30); `ops/tests/**` = **Codex** (fila 29).

RIESGO: BAJO — pero si producción cambia a `waitid(WNOWAIT)` (ya lo hace en L901-925), el test seguirá verde con la versión vieja.

---

### G-18 — `healthcheck.mjs` (scripts vs harness) — 2 ocurrencias — 10 líneas
- `ops/scripts/healthcheck.mjs:6-21` (21 líneas totales, valida `content-type`)
- `ops/harness/healthcheck.mjs:5-12` (más corta, sin content-type, con timeout hardcoded 3000ms)

CITA (`ops/scripts/healthcheck.mjs:6-13`):
```js
const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('health response is not JSON');
```

`ops/harness/healthcheck.mjs:4-7`:
```js
const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
```

Diferencias: la versión `scripts/` valida `content-type`, acepta `HEALTH_TIMEOUT_MS`; la versión `harness/` no.

HOGAR ÚNICO SUGERIDO: `ops/scripts/healthcheck.mjs` como canónico, importado por `ops/harness/healthcheck.mjs` (que pasa a ser un shim `#!/usr/bin/env node; import('../scripts/healthcheck.mjs')`).

DUEÑO: ambos `ops/scripts/**` y `ops/harness/**` = **Codex**.

RIESGO: MEDIO — la omisión de la validación `content-type` en `harness/` significa que si el gateway responde `text/plain` con un `200`, los tests del harness dirán "ready" sin haber parseado JSON.

---

### G-19 — Regex de `valid_alias` (bash inline + python `re.compile`) — 17 ocurrencias — 1 línea
La forma canónica estricta `^[a-z][a-z0-9-]*$` (o `\Z` en algunos .py) está repetida literal en ≥17 sitios. Listado completo verificado con grep:

Bash inline (regex literal):
- `ops/pty-agent/cauce-pty-launcher.sh:48-50` (función `valid_alias`)
- `ops/pty-agent/install-pty-agent.sh` (inline en línea de uso)
- `ops/scripts/container-adapter-supervisor.sh:60-62` (función `valid_alias`)
- `ops/scripts/cutover.sh` (inline)
- `ops/scripts/provision-hermes-runtime.sh` (inline)
- `ops/scripts/alias-runner.sh` (inline)

Bash con `.mjs` (test de regex en runtime):
- `ops/scripts/separar-config-alias.mjs`: `const ALIAS_VALIDO = /^[a-z][a-z0-9-]*$/u;`
- `ops/scripts/gate-collector.mjs:33`: `if (!/^[a-z][a-z0-9-]*$/.test(alias))`
- `ops/scripts/gate-roundtrip-probe.mjs:15`: idéntica

Python `re.compile`:
- `ops/container-runtime/cauce-container-runtime.py:31`: `ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]*$")`
- `ops/scripts/manifest_lib.py:14`: idéntica
- `ops/scripts/pin-container-release.py:25`: `ALIAS_RE = re.compile(r"[a-z][a-z0-9-]*\Z")` (variante con `\Z`)
- `ops/scripts/update_alias_lib.py:16`: misma que pin-container-release
- `ops/pty-agent/rollout_pty_lib.py`: `NAME_RE = re.compile(r"^[a-z][a-z0-9.-]*$")` (admite `.` también), `MODE_RE = re.compile(r"^[a-z][a-z0-9_-]*$")` (admite `_`)
- `ops/scripts/container_alias_lib.py`: `NAME_RE = re.compile(r"^[a-z][a-z0-9.-]*$")`
- `ops/scripts/dlq_cli.py`: `ALIAS = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")` (admite `_`, límite 64)
- `ops/scripts/generate-telegram-config.py:80`: `ALIAS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")` (admite `_`, límite 64)
- `ops/scripts/quota-collector.py`: `PROVIDER_RE` y `STATUS_RE` (parientes con `[._-]`)

CITA (`cauce-pty-launcher.sh:48-50` ↔ `container-adapter-supervisor.sh:60-62`):
```bash
valid_alias() {
  [[ $1 =~ ^[a-z][a-z0-9-]*$ ]]
}
```

CITA (`pin-container-release.py:25` ↔ `update_alias_lib.py:16`):
```python
ALIAS_RE = re.compile(r"[a-z][a-z0-9-]*\Z")
```

HOGAR ÚNICO SUGERIDO: `ops/scripts/alias_re.py` para Python (constante única `ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]*$")` con docstring justificando el subset ASCII-lower + `-`); para bash, función `valid_alias` en el futuro `ops/scripts/lib.sh`; para `.mjs`, constante exportada desde el mismo lugar.

DUEÑO: mixto — `ops/pty-agent/**` = **Gemini**, `ops/scripts/**` = **Codex**, `ops/container-runtime/**` = **Claude**.

RIESGO: MEDIO — divergencia REAL entre las variantes. `dlq_cli.py` y `generate-telegram-config.py:80` admiten `_` y truncan a 64 chars; `rollout_pty_lib.py` admite `.`; el resto solo `-`. Si dos sistemas canjean el mismo alias pero con alfabetos distintos, uno rechaza y el otro acepta — bug silencioso de identificación.

---

### G-20 — Imports comunes Python en tooling de ops — 4 ocurrencias — 6 líneas
- `ops/pty-agent/rollout_pty_lib.py:4-19`
- `ops/scripts/dlq_cli.py:5-19`
- `ops/scripts/update_alias_lib.py:4-12`
- `ops/scripts/provision-alertmanager-config.py:13-21`

CITA (`update_alias_lib.py:4-12` ↔ `dlq_cli.py:5-14`):
```python
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
from typing import Any
```

Diferencias: el orden y la presencia de cada import varía (`dlq_cli` añade `subprocess`, `sys`, `tempfile`; `rollout_pty_lib` mete `base64`, `fcntl`, `uuid`, `dataclasses`).

HOGAR ÚNICO SUGERIDO: NO urge (no hay bloque funcional duplicado — son solo imports). Anotado porque el patrón `argparse / hashlib / json / os / pathlib / re / stat` aparece en los 4 y centralizarlo no aporta valor real; un `from ops_scripts.common import *` introduce acoplamiento sin reducir líneas. **Descartado como hogar-único accionable.**

DUEÑO: mixto.

RIESGO: BAJO.

---

## Resumen

| grupo | ocurrencias | líneas (×oc) | zonas | dueño | riesgo |
|---|---:|---:|---|---|---|
| G-1  `cauce` == `cauce-kratos.sh` | 2 | 565 | ops/cli, ops/guardias | Claude | alto |
| G-2  `cauce-portatil` == `cauce-envoltorio-local.sh` | 2 | 115 | ops/cli, ops/guardias | Claude | medio |
| G-3  probes HTTP en deploy/ | 4 | 50 | deploy | NADIE | alto |
| G-4  fd-following + open_regular_at + file_identity | 3 | 40 | ops/scripts, ops/container-runtime | Codex + Claude | medio |
| G-5  helpers bash (`assert_secure_*`, `die`, `docker_control`, `valid_alias`, `valid_absolute_path`) | 2 | 50 | ops/pty-agent, ops/scripts | Gemini + Codex | medio |
| G-6  hardening systemd block | 2 | 17 | ops/scripts | Codex | bajo |
| G-7  `atomic_write` / `_atomic_write` | 2 | 12 | ops/scripts | Codex | bajo |
| G-8  `waitUntil` + `sleep` | 2 | 12 | ops/harness | Codex | bajo |
| G-9  preámbulo tests `pty-agent/tests/*.py` | 10 | 10 | ops/pty-agent/tests | Gemini | bajo |
| G-10 mapa `tenants` / `tenantAgents` / `topology` | 3 | 6 (+variante) | ops/harness | Codex | alto |
| G-11 `boundedInteger` | 2 | 8 | ops/scripts | Codex | bajo |
| G-12 `redactUrl` | 2 | 7 | ops/harness | Codex | bajo |
| G-13 `WsClient.next` | 2 | 9 | ops/harness | Codex | bajo |
| G-14 bucle `write_all(payload)` + fsync | 2 | 6 | ops/scripts | Codex | bajo |
| G-15 whitelist tests en `container_ops_digest` duplicada en su test | 2 | 9 | ops/scripts, ops/tests | Codex | alto |
| G-16 sonda `git rev-parse --show-toplevel` | 2 | 6 | ops/scripts | Codex | bajo |
| G-17 `reap_children` (producción + test) | 2 | 6 | ops/container-runtime, ops/tests | Claude + Codex | bajo |
| G-18 `healthcheck.mjs` (scripts vs harness) | 2 | 10 | ops/scripts, ops/harness | Codex | medio |
| G-19 regex `valid_alias` (bash) y `ALIAS_RE` (py) | 17 | 1 | ops/pty-agent, ops/scripts, ops/container-runtime | Gemini + Codex + Claude | medio |
| G-20 imports comunes Python | 4 | 6 | ops/scripts, ops/pty-agent | mixto | bajo |

**Total líneas duplicadas (sumando bloques únicos por par de ficheros)**: ~1170 líneas. El ~55% de la duplicación vive en zonas de **Claude** (G-1 + G-2 + G-4-tercio + G-17-tercio + G-19-tercio); el ~38% en zonas de **Codex** (G-4-tercio + G-6..G-8 + G-10..G-16 + G-18..G-19); el ~5% en **Gemini** (G-5-tercio + G-9); y ~2% en zona **NADIE** (G-3, FASE 3).

**Acción prioritaria** (mayor riesgo + mayor tamaño):
1. G-1 (`cauce` ↔ `cauce-kratos.sh`): 565 líneas, ALTO, dueño único Claude — puede ir en un solo commit del dueño.
2. G-3 (probes `deploy/`): NADIE, FASE 3 — solo señalización.
3. G-10 (`tenants`/`tenantAgents`/`topology`): ALTO, ya diverge — Codex debe unificar y decidir si `zeus`/`atlas`/`iza` son alias vivos.
4. G-15 (whitelist duplicada en su propio test): ALTO, el test **miente** — Codex debe reescribir el test para importar la constante.
5. G-2 (`cauce-portatil` ↔ `cauce-envoltorio-local.sh`): 115 líneas, MEDIO, Claude — patrón ya usado con `cauce-huerfanas.sh`.

El resto (G-4..G-20) es la "vigilancia normal" del catálogo: cada uno es un hogar-único factible en un commit propio del dueño correspondiente.