# Caza de duplicados copy-paste — árbol completo

Método: detector de ventanas propio por zona (normaliza cada fichero — quita comentarios, colapsa espacios, descarta líneas vacías —, genera todas las ventanas de N líneas consecutivas con N=6 y N=10, agrupa por SHA-1, filtra grupos con ≥2 ficheros distintos) y después **verificación a mano de cada grupo leyendo los dos lados**. Solo entra en este reporte lo que se puede citar textualmente con `ruta:línea` de ambas caras. Tres subagentes con sectores disjuntos: backend (`packages/*/src` + `services/*/src`), consola+tests, ops+scripts+deploy. Parciales completos con las citas: `_parcial-dup-backend.md`, `_parcial-dup-console.md`, `_parcial-dup-ops.md`.

**51 grupos confirmados · ~2.250 línea-ocurrencias duplicadas.** El caso `@import×11` que disparó la orden resultó ser más grande de lo que se creía y no estaba donde se pensaba (ver G-C1).

## Los 8 que hay que arreglar primero

Ordenados por daño real, no por tamaño. "Divergió" = las copias YA no son iguales, así que la duplicación no es solo deuda: es un bug latente en producción.

### 1. `ops/cli/cauce` es una copia literal de 565 líneas de `ops/guardias/cauce-kratos.sh` — DIVERGIÓ

El duplicado más grande del repo, con diferencia. Verificado mecánicamente: `diff` normalizado de ambos ficheros devuelve **11 líneas distintas sobre 565/568** — y las 11 son comentarios.

```
$ wc -l ops/cli/cauce ops/guardias/cauce-kratos.sh
  565 ops/cli/cauce
  568 ops/guardias/cauce-kratos.sh
$ diff <(sed 's/[[:space:]]\+/ /g' ops/cli/cauce) \
       <(sed 's/[[:space:]]\+/ /g' ops/guardias/cauce-kratos.sh) | grep -c "^[<>]"
11
```

Cuerpo idéntico desde la línea 22/23 en ambos (`ops/cli/cauce:22-29` ↔ `ops/guardias/cauce-kratos.sh:23-30`):

```sh
alias_info() {  # $1=alias -> "tenant\troom\tcontenedor\tusuario\thome\tstate\tharness"
  PYTHONDONTWRITEBYTECODE=1 python3 "$OPS/scripts/container-alias-query.py" "$1" 2>/dev/null
}
todos_los_alias() {
  for f in "$CONFIG"/*.env; do
    [ -e "$f" ] || continue; basename "$f" .env
  done | sort
}
```

**HOGAR ÚNICO:** `ops/cli/cauce` — su propia cabecera ya declara «ESTE FICHERO ES LA FUENTE. Se instala en kratos…». `ops/guardias/cauce-kratos.sh` debe quedar como shim de 5 líneas, exactamente como ya hizo su primo `ops/guardias/cauce-huerfanas.sh:5-13`. **Dueño:** Claude. **Riesgo:** alto — el CLI del dueño se invoca desde dos contextos y ya divergió una vez; ese es el motivo de que `cauce-huerfanas.sh` sea shim hoy.

### 2. El caso `@import` real: 15 copias del resolutor de CSS en los tests de la consola — DIVERGIÓ

El `@import×11` del enunciado no eran los `@import` de los CSS (esos son **13, en 3 ficheros, sin ningún destino repetido** — legítimos). Es el **resolutor recursivo de `@import` copiado en los tests de legibilidad**, y son 15, no 11:

```
$ grep -rn "@import" apps/console/src --include=*.css | wc -l
13
$ grep -rln "replace(/@import" apps/console/src --include=*.test.* | wc -l
15
```

**HOGAR ÚNICO:** `apps/console/src/test/leer-css.ts` con `leerCss(absPath)` + `leerCssDesdeRaiz(relPath)`. **Dueño:** Gemini. **Riesgo:** alto — `xterm-csp.test.ts:27-34` ya forkeó los nombres (`content`/`relPath`), y 3 ficheros usan una segunda variante con ruta absoluta. Un bug del resolutor (ciclo `@import` infinito, `@import url(...)`) se arreglaría solo en una parte del lote. Se cierra de una vez junto con G-C12 (`sinComentarios`, 6 copias) y G-C13 (`bloqueMedia`/`declaraciones`/`valor`, 4-5 copias) porque viajan siempre en el mismo bloque.

### 3. `stringField` escrito 6 veces en el árbol vivo, y la 6ª acepta string vacío — DIVERGIÓ

```
$ grep -rn "const stringField\|function stringField" services/ packages/ --include=*.ts
services/terminal-relay/src/agent-hello.ts:129
services/terminal-relay/src/governance-read.ts:83
services/terminal-relay/src/governance-write.ts:33
services/terminal-relay/src/gateway-client.ts:140
services/gateway/src/console/relay-governance-client.ts:59
services/gateway/src/terminal/registry.ts:189
packages/adapter-sdk/src/sdk/websocket-transport.ts:225
```

`agent-hello.ts:129` ya lo exporta; los otros cinco lo redefinen. **La copia divergida acepta `''` como campo presente**, así que una ruta del gateway puede entregar cadena vacía a un consumidor del relay que la rechaza: validadores desincronizados sobre el mismo wire. **HOGAR ÚNICO:** `services/terminal-relay/src/_string-field.ts` (o exportar el de `agent-hello.ts`). **Dueño:** Gemini (relay) coordinando con Codex (gateway). **Riesgo: ALTO.**

### 4. La forma del ACK de outbox declarada tres veces, con `connection` opcional en un lado y obligatorio en otro — DIVERGIÓ

`store` declara `connection?`, `gateway` lo requiere, `telegram-bridge` añade `effect_count?` que nadie más conoce. Un ACK que omite `connection` rompe el gateway sin que TypeScript se queje, porque el llamador hace `as OutboxLeaseAck`. **HOGAR ÚNICO:** `packages/protocol/src/outbox-contracts.ts` con `OutboxAck` y las extensiones por composición. **Dueño:** Codex (protocol/gateway) + Gemini (bridge). **Riesgo: ALTO.** Detalle y citas en `_parcial-dup-backend.md` G-15.

### 5. `EgressDestinationRow` vs `DestinationRow`: la misma fila de BD copiada y divergida — DIVERGIÓ

`conversation_kind` está estrechado en una cara y ancho en la otra; `display_label` falta en una. Una mutación que escribe `'channel'` donde el otro lado espera `'channel_post'` se acepta al leer por notificaciones y rompe al revalidar configuración. **HOGAR ÚNICO:** `packages/store/src/repository/egress-destinations.ts`. **Dueño:** Codex. **Riesgo: ALTO.** (`_parcial-dup-backend.md` G-9.)

### 6. La whitelist de `container_ops_digest.py` duplicada dentro del test que la verifica — el test no prueba nada

El test pasa si las dos listas están sincronizadas, pero no comprueba que la lista cubra lo que dice cubrir: la duplicación literal **destruye el propósito del test**. Debe importar `OPERATIONS_SOURCES` del módulo. **Dueño:** Claude/Codex. **Riesgo: ALTO.** (`_parcial-dup-ops.md` G-15.) Este caso pertenece también a la auditoría de dientes: es un test tautológico por construcción.

### 7. El mapa tenant→alias escrito tres veces en `ops/harness/`, y una copia tiene alias que las otras no — DIVERGIÓ

`ops/harness/runner.mjs` incluye `zeus`, `atlas` e `iza`; `contract-runner.mjs` y `mock-server.mjs` no. Resultado: esos tres alias **no están cubiertos por los contract tests y nadie se queja**. **HOGAR ÚNICO:** `ops/harness/fleet.mjs` con la forma completa `{tenant: {room, aliases}}`. **Dueño:** Codex. **Riesgo: ALTO.** (`_parcial-dup-ops.md` G-10.)

### 8. `fakePool()` en 9 sitios con dos shapes de fila distintos — DIVERGIÓ

8 copias en `services/gateway/src/*.test.ts` devuelven `{ '?column?': 1 }`; la de `tests/gateway-hardening/helpers.ts:57` devuelve `{ ssl: ... }`. Es literalmente el caso "el mismo helper escrito en `tests/gateway-hardening` y en `services/gateway/src/*.test.ts`". **HOGAR ÚNICO:** `services/gateway/src/__test-helpers__/pool.ts`, re-exportado desde el helper de hardening. **Dueño:** Codex crea, Gemini importa. **Riesgo: ALTO.** (`_parcial-dup-console.md` G-10.)

## Resto de grupos confirmados

### Backend — `packages/*/src` + `services/*/src` (18 grupos, ~497 línea-ocurrencias)

| grupo | qué es | ocurr. | líneas | hogar único sugerido | dueño | riesgo |
|---|---|---:|---:|---|---|---|
| G-B1 | parser `project_doc` de Codex (constantes + `validCodexFallbackFilename` + `codexProjectDocumentFields`) | 2 | 41 | `packages/protocol/src/agent-codex-project-doc.ts` | Codex | medio |
| G-B2 | construcción de `TerminalAuditContext` desde una row | 5 | 9 | `services/gateway/src/terminal/audit.ts` | Codex | medio — `cohort` ya diverge (`cohort: []` literal en 4 sitios vs `cohortLabels(policy.cohort)`) |
| G-B3 | envoltorio `BEGIN … COMMIT/ROLLBACK/finally release` | 4 | 10 | `terminal/relay-proxy/context.ts` → `withRelayProxyTransaction` | Codex | bajo |
| G-B4 | UPDATE de claim-takeover (`relay_claim_sha256` + `epoch+1` + LEAST) | 2 | 16 | `terminal/relay-proxy/context.ts` → `takeoverSessionClaim` | Codex | bajo |
| G-B5 | SELECT `membership.room_id` con JOINs de memberships/role_policies/tenants/rooms | 5 | 6 | `packages/store/src/repository/agents/_routing-room.ts` | Codex | medio — `FOR SHARE`/`LIMIT 1` difieren |
| G-B6 | validador ISO-8601-UTC estricto | 3 | 10 | `packages/protocol/src/iso-utc.ts` | Codex | bajo |
| G-B7 | INSERT `audit_events` transaccional | 2 | 13 | `terminal/audit.ts` → `recordTerminalAuditOn(executor, …)` | Codex | bajo |
| G-B8 | `replyError` con cascada AuthError/AuthorizationError | 2 | 12 | `routes/shared.ts` (plugin importa) | Codex | medio — la rama `StoreError` diverge: 404/422/500 vs 404/403 |
| G-B10 | clasificador de code-points hostiles (C0/C1 + bidi + invisibles) | 3 | 7 | `packages/protocol/src/has-unsafe-codepoint.ts` | Codex | medio |
| G-B11 | derivación de UUIDv7 desde SHA-256 truncado | 4 | 5 | `packages/store/src/repository/_hash-to-uuidv7.ts` | Codex | bajo |
| G-B12 | `sleep(ms, signal)` con AbortSignal | 2 | 10 | `services/telegram-bridge/src/abort-sleep.ts` | Gemini | bajo |
| G-B13 | sub-SELECT EXISTS de autorización de actor | 2 | 13 | `repository/agents/_actor-route.ts` | Codex | medio — el gateway solo implementa `control`, se queda ciego ante un tercer permiso |
| G-B14 | `DELEGATION_REJECTION_CODES` (subset duplicado) | 2 | 10 | derivar el subset con `satisfies` desde `@cauce/protocol` | Codex | medio |
| G-B16 | preámbulo de parseo de trama JSON de WebSocket | 2 | 7 | `services/terminal-relay/src/_parse-json-frame.ts` | Gemini | bajo |
| G-B17 | parser de epoch BigInt de relay-claim + `POSTGRES_BIGINT_MAX` | 2 | 7 | `packages/protocol/src/postgres-bigint.ts` | Codex | bajo |

### Consola + tests (13 grupos, ~580 línea-ocurrencias)

| grupo | qué es | ocurr. | líneas | hogar único sugerido | dueño | riesgo |
|---|---|---:|---:|---|---|---|
| G-C2 | `afterAll` con `pool.end()` + `container.stop()` | 28+ | 4 | `tests/helpers/postgres.ts` → `closeTestDatabase()` | Gemini (usos en ambos sectores) | medio |
| G-C3 | `function command(overrides: Partial<PublishMessage>)` | 13 | 16 | `packages/store/test/command-fixture.ts` | Codex | bajo (208 líneas) |
| G-C4 | `beforeEach` con el SQL que habilita acl_edges/tenants/rooms/memberships | 14 | 7 | `tests/helpers/enable-everything.ts` | Gemini + Codex | alto — divergió en `egress-notification:208-218` y `lease-cap:108-113` |
| G-C5 | arrays `apps`/`sockets` + `afterEach` que cierra ambos | 8 | 7 | `tests/gateway-hardening/helpers.ts` | Gemini | medio |
| G-C6 | `function text(data: RawData): string` | 8 | 6 | `tests/gateway-hardening/helpers.ts` | Gemini | bajo |
| G-C7 | `interface Consumer` + `consumer()` + `nextDelivery` + `terminalAck` | 6 | ~30 | `packages/store/test/_fixtures/consumer.ts` | Codex | medio (180 líneas) |
| G-C8 | helpers de fase de migración 036/037 (`shadowPhaseExists`, …) | 4 | ~30 | `packages/store/test/_fixtures/migration-phase.ts` | Codex | medio (120 líneas) |
| G-C9 | array `apps` + `afterEach pop().close()` en tests de gateway | 5 | 5 | `services/gateway/src/__test-helpers__/close-apps.ts` | Codex | bajo |
| G-C11 | preámbulo `const repository = resolve(dirname(fileURLToPath(...)))` | 13 | 6 | `tests/helpers/repository-root.ts` | Gemini | bajo |
| G-C12 | `function sinComentarios(css)` | 6 | 3 | junto con G-C1 en `apps/console/src/test/` | Gemini | bajo |
| G-C13 | `bloqueMedia` (+`declaraciones`, `valor`) | 4 (+5+5) | 18 | `apps/console/src/test/css-parser.ts` | Gemini | medio — `declaraciones` ya tiene DOS firmas semánticamente distintas (último bloque vs mapa propiedad→valor) |

### ops + scripts + deploy (20 grupos, ~1.180 línea-ocurrencias)

| grupo | qué es | ocurr. | líneas | hogar único sugerido | dueño | riesgo |
|---|---|---:|---:|---|---|---|
| G-O2 | `cauce-portatil` == `cauce-envoltorio-local.sh` | 2 | 115 | `ops/cli/cauce-portatil` + shim | Claude | medio |
| G-O3 | probes HTTP `deploy/{liveness,readiness,local-readiness,unix-readiness}-probe.mjs` | 4 | 50 | **NO TOCAR** (`deploy/` es zona NADIE, FASE 3) | — | alto — ya divergieron en cap de respuesta, guarda mTLS y socket path |
| G-O4 | `open_absolute_directory` + `open_regular_at` + `file_identity` | 3 | ~40 | `ops/scripts/fs_lib.py` | Codex + Claude | alto — mensajes ya en idiomas distintos |
| G-O5 | `assert_secure_file`/`assert_secure_directory`/`die`/`docker_control`/`valid_alias` (bash) | 2 | ~50 | `ops/scripts/assert-secure.sh` sourced | Claude/Gemini | medio |
| G-O6 | bloque de hardening systemd (`NoNewPrivileges`…`CapabilityBoundingSet`) | 2 | 17 | `ops/scripts/systemd_hardening.py` | Claude | bajo, consecuencia alta: units vivas con superficies distintas a igual rol |
| G-O7 | `atomic_write` (tempfile + fsync + replace) | 2 | 12 | `ops/scripts/fs_lib.py` | Codex | bajo |
| G-O8 | `waitUntil(operation, timeoutMs)` + `sleep` | 2 | 12 | `ops/harness/wait-until.mjs` | Codex | bajo |
| G-O9 | preámbulo de tests de pty-agent (`sys.path` + `import cauce_pty_agent`) | 10 | ~10 | `ops/pty-agent/tests/conftest.py` | Gemini | bajo |
| G-O11 | `boundedInteger(name, fallback, min, max)` | 2 | 8 | `ops/scripts/env-int.mjs` | Claude | bajo |
| G-O12 | `redactUrl(value)` | 2 | 7 | `ops/harness/redact.mjs` | Codex | bajo — la regex no atrapa `apikey`/`api-key`/`access_token`; se arreglará en uno solo |
| G-O13 | `WsClient.next(predicate, timeoutMs)` | 2 | 9 | `ops/harness/ws-client.mjs` | Codex | bajo |
| G-O14 | bucle `write_all(payload)` con manejo de short-write | 2 | 6 | `ops/scripts/fs_lib.py` | Codex | bajo |
| G-O16 | sonda `git rev-parse --show-toplevel` | 2 | 6 | `ops/scripts/git_probe.py` | Claude | bajo |
| G-O17 | `reap_children` / bucle `waitpid` | 2 | 6 | — (el de producción ya usa `waitid(WNOWAIT)`) | Claude | bajo — el test seguirá verde con la versión vieja |
| G-O18 | `healthcheck.mjs` (scripts ↔ harness) | 2 | 10 | `ops/scripts/healthcheck.mjs` canónico + shim | Claude/Codex | medio — la copia del harness omite la validación de `content-type` |
| G-O19 | regex de `valid_alias` | **17** | 1 | `ops/scripts/alias_re.py` + `lib.sh` + constante `.mjs` | Claude/Codex | medio — divergió de verdad: `dlq_cli.py` y `generate-telegram-config.py:80` admiten `_` y truncan a 64; `rollout_pty_lib.py` admite `.`; el resto solo `-`. **Dos sistemas canjeando el mismo alias con alfabetos distintos.** |

Descartados como no accionables tras leerlos: G-B18/G-O20 (bloques de imports estándar: centralizarlos añade acoplamiento sin reducir líneas) y las unidades systemd *generadas* de `ops/generated/**` (su duplicación literal es la salida esperada del generador; solo cuenta el duplicado en la fuente, que es G-O6).

## Nota de método

Los tres detectores viven en `/tmp/opencode/` y no se comitean: son de un solo uso y el entregable es la evidencia citada, no la herramienta. El umbral efectivo fue ≥6 líneas *funcionales* idénticas tras normalizar, en ≥2 ficheros distintos. Falsos positivos descartados en la verificación manual: shebangs, `set -euo pipefail`, `from __future__ import annotations`, imports sueltos, boilerplate de `describe`, listas de campos que por contrato deben ser explícitas, y aserciones legítimamente repetidas sobre casos distintos.
