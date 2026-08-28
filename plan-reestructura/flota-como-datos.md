# Flota como datos — diseño ejecutable (una ronda, pre-despliegue)

## 0. Regla que gobierna todo

La BD (`agents` + `memberships`) es la ÚNICA verdad. Un comando la exporta a `ops/flota.json` (versionado). **Todo lo demás se genera de ahí y nada más se edita a mano.** Los gates siguen siendo herméticos: nunca abren la BD, solo leen el snapshot. Un probe en despliegue certifica BD↔snapshot. Alta/baja/cambio de agente = 1 sentencia SQL + `cauce <alias> aprovisionar` + re-exportar/regenerar/commitear.

## 1. El snapshot: `ops/flota.json`

Formato JSON, `schemaVersion: 1` propio (no reusa el 1 de `/opt/.../fleet.json` ni el 2 de `container-aliases.json`). Escritor canónico obligatorio: `json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=False) + "\n"`. **Sin `generatedAt`, sin hostname, sin comentarios**: re-exportar con la BD sin cambios debe dar bytes idénticos o los digests (`OPERATIONS.sha256`, `mappingSha256` del release PTY, `source-digest`) nunca convergen.

```json
{ "schemaVersion": 1,
  "fleet": { "kant": { "tenant":"Steven","room":"grp.steven","role":"operator","harness":"codex",
                       "enabled":true,"container":"host:kratos","user":"stev","home":"/home/stev",
                       "runtimeStateDirectory":"/var/lib/cauce-v3/aliases/kant" } },
  "systemPrincipals": { "quota-collector": {"tenant":"Steven","room":"grp.steven","role":"operator"} },
  "retired": { "dedalo": {} },
  "placement": { "kant": {"registryContainer":"host:kratos","healthContainer":"ctrl-infra"},
                 "salva": {"dockerHost":"kratos"} } }
```

| Bloque | Fuente | Por qué está |
|---|---|---|
| `fleet.*` (9 claves) | BD: `agents` + `memberships` (1:1, literal) | claves de BD; `container/user/home/runtimeStateDirectory` se copian del literal, no se re-derivan: la fórmula tiene DOS ramas (contenedor vs host, caso kant) y la BD ya resolvió cuál |
| `systemPrincipals` | BD: membership sin fila en `agents` | actor virtual sin colocación física (quota-collector) |
| `retired` | BD: `agents.enabled=false` | **cierra el agujero de `historicalAliases`**: deja de ser bookkeeping manual; satisface por construcción el invariante `expectedEnabled:false` + no-solape de `rollout_pty_lib` |
| `placement` | overlay `ops/flota-fisica.json` (a mano, gateado) | el residuo real medido: `dockerHost`, `registryContainer`, y el `container` de health cuando diverge. Ausencia = defaults (`local`, `=container`) |

**`enabled` tiene UNA sola fuente: `agents.enabled`.** Habilitado → `fleet`; deshabilitado → `retired` (sin unit, sin manifest, sin watchdog). Se acaban las tres nociones discordantes.

**Fuera del snapshot por diseño**: todo lo que es fórmula pura de `(alias, harness)` — los 15 `CAUCE_<ALIAS>_*_PATH/URL`, `apiVersion/kind`, `seedOnConnect`, `configScope`, `transport`, `requiredScheme`, `workspace` de openclaw, `operationalModelEnv` de hermes, el `stateDirectory` del manifest, `systemdUser` (constante `stev` → default de flota) y `schemaVersion: 2`. Y el material de los secretos: el snapshot solo conoce NOMBRES de variables, nunca valores.

## 2. Qué deja de editarse a mano

| Fichero | Decisión | Justificación |
|---|---|---|
| `ops/container-aliases.json` | **GENERADO**, misma ruta, mismo `schemaVersion 2`, bytes idénticos al de hoy | Fusionarlo en el snapshot es el final correcto, pero cuesta reescribir ~20 consumidores, 3 parsers duplicados, re-firmar el release PTY y todas las fixtures. En una ronda bloqueante: se genera. Ojo: `container_alias_lib` valida claves top-level EXACTAS → **es imposible poner un banner "NO EDITAR" dentro**; el banner es el gate (§6) |
| `ops/manifests/*.yaml` | **GENERADOS** con purga de huérfanos | Todos sus campos son const, fórmula de `(alias,harness)` o BD. Se emiten con f-string (como `generate-units.py` emite systemd), NO con `yaml.safe_dump`: hay que reproducir el estilo flow (`{seedOnConnect: true, configScope: alias}`) byte a byte |
| `ops/generated/**` | siguen generados, sin cambios de código | ya lo estaban |
| `ops/generated/fleet.json` (**nuevo**) | generado en forma `schemaVersion 1` (7 campos + `enabled`) | alimenta el trío no versionado de `/opt` (`fleet.json` + `fleet_source.py` + watchdog) sin tocarlo: su input pasa de transcripción a mano a derivado de BD. Mata el drift de `gaia` |
| `ops/flota-fisica.json` (**nuevo**) | ÚNICO fichero a mano, 3 claves permitidas | hoy afecta a 2 de 11 agentes; un alta normal no lo toca |

Cadena: `BD → export → ops/flota.json → generate → container-aliases.json + manifests/ → generate → generated/{systemd,container-systemd,fleet.json} + telegram-runtime/config.json`.

## 3. Las fórmulas viven en UNA casa: `ops/scripts/fleet_derive.py`

Módulo puro (sin IO, sin BD, sin dependencias), importado por todos los generadores. Contiene: `HARNESS_RULES` (por arnés: rama de `stateDirectory` contenedor/host, `workspace`, `operationalModelEnv`), `env_name(alias, kind)` → `CAUCE_{ALIAS}_{TOKEN_PATH|CERT_PATH|KEY_PATH|CA_PATH|RELAY_URL|EXEC_PATH}`, `SYSTEMD_USER="stev"`, `alias_entry(alias,row,placement)`, `manifest_doc(alias,row)`. Nombra sin ambigüedad las **dos** rutas homónimas: `runtime_state_directory()` (dentro del contenedor) vs `HOST_STATE_DIRECTORY = /var/lib/cauce-v3/aliases/{alias}` (StateDirectory= de systemd). Las claves del wire no se renombran (rompería validadores y schema); el docstring y este doc fijan la distinción.

## 4. Generadores a escribir / extender

| Script | Estado | Contrato |
|---|---|---|
| `ops/scripts/fleet-query.sql` | NUEVO | la ÚNICA consulta (agents/memberships/role_policies), leída por el exportador y por el probe de deploy — una consulta, no dos copias |
| `ops/scripts/export-fleet-snapshot.py` | NUEVO — **jamás lo invoca un gate** | `--out ops/flota.json` escribe canónico; `--check` compara y sale 3 si difiere; valida en el export que todo `dockerHost` mapea a `{local,kratos}` (invariante de managers de `rollout_pty_lib`) y que ningún tenant cae fuera del enum del schema: **falla ruidoso, nunca descarta filas** |
| `ops/scripts/fleet_derive.py` | NUEVO | §3 |
| `ops/scripts/generate-container-aliases.py` | NUEVO | reescribe el fichero entero (purga inherente), escritura atómica |
| `ops/scripts/generate-manifests.py` | NUEVO | emite `<alias>.yaml` y **desenlaza los huérfanos** (stem fuera del snapshot), igual que hace `generate-units.py` con las units |
| `generate-units.py`, `generate-container-units.py` | EXTENDER mínimo | importar `fleet_derive` donde re-implementan fórmulas; el resto intacto (menos churn = menos riesgo) |
| `generate-telegram-config.py` | sin cambios | su cross-check ahora compara dos derivados del mismo snapshot: pasa de lockstep frágil a chequeo anti-manipulación |
| `ops/scripts/regenerate-fleet.sh` | NUEVO | ejecuta la cadena entera en orden; nadie regenera a mano media flota |

## 5. Credenciales: `cauce <alias> aprovisionar`

Subcomando nuevo en `ops/cli/cauce` (dispatch de `case "${1:-}"`, junto a `on|off|login`), con `--dry-run`. **No escribe en la BD**: imprime el SQL exacto para que lo corra el dueño. Encadena, en orden, y termina verificando el EFECTO (`cauce <alias> ver` + `install-pty-agent.sh` en modo check):

| # | Pieza | Script |
|---|---|---|
| 0 | prerequisito bloqueante del dueño | documentar en `ops/private/CREDENTIAL-INVENTORY.local` **dónde vive `ca.key`** (hoy solo llega por `CAUCE_CLIENT_CA_KEY`, sin ruta fija) |
| 1 | `agent-<alias>.{crt,key}` | `ops/scripts/provision-agent-identity.sh` — generaliza `provision-terminal-client.sh` (openssl → CSR → x509, EKU clientAuth, publicación atómica 0400/0444 sin sobrescribir). **La allowlist de CN deja de estar quemada**: se deriva del snapshot (`agent-<alias>` ∀ alias ∈ `ops/flota.json`, más los 2 CN fijos) |
| 2 | bearer token + hash | `ops/scripts/issue-alias-token.py` — `secrets.token_hex(32)`, publica 0400, calcula sha256 y lo inserta en `token_hashes.json`/`mtls_identities.json` con flock + rename atómico (patrón CAS ya presente en `update_alias_lib.py`) |
| 3 | `alias-key.hex` (PTY) | `ops/pty-agent/publish-alias-key.sh` — envuelve el `derive-alias-key.py` que YA existe y publica su stdout 0400 |
| 4 | `container-pki/<alias>/` + `<alias>.env` | mismo emisor de (1) con destino contenedor + modo `--init` nuevo en `update-alias-config.py` (hoy solo sabe actualizar, no crear) |
| 5 | Telegram | `generate-telegram-config.py` ya emite la estructura; el CLI pide pegar el token de BotFather (única pieza no generable) y **verifica que llegó** (existe, 0600, dueño correcto, no vacío) |

`cauce <alias> retirar` (baja): para/deshabilita la unit, revoca el hash del token por CAS, y recuerda el `UPDATE agents SET enabled=false` — en ese orden (primero BD: el gateway deja de autorizar; `authority.ts` lee `agents` en vivo).

## 6. Gates

| Gate | Cambio |
|---|---|
| `validate.sh` (maestro) | **+2 bloques `cmp -s` nuevos, antes de todo lo demás**: regenerar `container-aliases.json` y `manifests/` desde `ops/flota.json` en tmpdir y exigir identidad byte a byte. Esto ES el gate "prohibido editar generados a mano" — no hace falta script nuevo |
| `manifest_lib` exact-set | código intacto; su significado cambia: ambos lados salen del mismo snapshot, así que pasa de invariante frágil a anti-tamper |
| `container_ops_digest.py` | **añadir `ops/flota.json` y `ops/flota-fisica.json` a `OPERATIONS_SOURCES`** — sin esto el snapshot podría cambiar sin invalidar `OPERATIONS.sha256` (agujero) |
| `source-digest.py` + `source-digest-domains.test.mjs` | pinear `ops/flota.json` en el dominio `verification`/`full` (la regla del test: estrechar un digest es la dirección peligrosa) |
| `physical-fleet-gate.py` | sin cambios de código; **sube de 11 a 14 contenedores exigidos** tras la reconciliación (§9 R2) |
| `rollout_pty_lib` / release PTY | cambian los bytes de `container-aliases.json` → cambia `mappingSha256` → **hay que re-publicar y re-firmar el release en la misma ronda**; y `historicalAliases` deja de estar vacío: el invariante se ejercita con datos reales por primera vez |
| **G-SNAP-1 (NUEVO, deploy, FASE 3)** | probe de paridad BD↔snapshot: `deploy/runtime/fleet-snapshot.mjs` deja de ser huérfano — pasa a leer `fleet-query.sql` y a comparar contra `ops/flota.json`; drift → **exit 3, nunca verde falso**. Es el "release parity gate" que `authority.ts:27` prometía y que nunca se escribió |
| **G-SNAP-2 (NUEVO)** | higiene del overlay: solo 3 claves permitidas, solo alias presentes en el snapshot, y ningún valor igual al default (impide que el overlay vuelva a ser un inventario paralelo) |
| **G-SNAP-3 (NUEVO)** | idempotencia hermética: generar dos veces sobre una fixture da bytes idénticos, y el `container-aliases.json` generado pasa `container_alias_lib` + `manifest_lib` |
| **G-SNAP-4 (NUEVO)** | paridad de los 4 lectores duplicados (`gate-collector.mjs`, `gate-roundtrip-probe.mjs`, `provision-hermes-runtime.sh`, `update_alias_lib.py`) contra `container_alias_lib`: no se unifican esta ronda, se **pinean** |

## 7. Reparto (ficheros disjuntos, 4 instancias, tope 4 subagentes, profundidad 1)

| Instancia | Rutas propias | Tareas | Hecho = |
|---|---|---|---|
| **Codex** | `ops/scripts/**`, `ops/tests/**` | C1 `fleet_derive.py`; C2 `export-fleet-snapshot.py` + `fleet-query.sql`; C3 los dos generadores nuevos + purga; C4 los 4 gates nuevos + inputs de digests | **Fase A pegada**: con un `ops/flota.json` construido para igualar el inventario de HOY, `generate-container-aliases.py` + `generate-manifests.py` reproducen los ficheros commiteados **byte a byte** (`cmp -s` en verde) + `pnpm typecheck && pnpm lint && pnpm test:unit` |
| **Claude (+dueño)** | `ops/flota.json`, `ops/flota-fisica.json`, `ops/container-aliases.json`, `ops/{manifests,generated,cli,private}/**`, `ordenes/00-PROTOCOLO.md` | K1 export read-only → **libro de reconciliación de 5 filas** (gaia/heraclito/tales ausentes, iza, kant) resuelto por el dueño EN LA BD; K2 commit único de snapshot + todos los derivados con `validate.sh` verde; K3 `aprovisionar`/`retirar` en el CLI; K4 (FASE 3) probe en deploy, instalar `fleet.json` en `/opt`, correr la demo; K5 añadir a la tabla de sectores la fila que falta para los ficheros sueltos de `ops/` | `validate.sh` pegado en verde con el snapshot REAL; libro de reconciliación con la decisión del dueño fila por fila |
| **Gemini** | `ops/pty-agent/**`, `ops/runbooks/**`, `tests/**` | G1 re-publicar/re-firmar el release PTY con los bytes nuevos + tests de `Fleet.load` con `historicalAliases` no vacío; G2 `publish-alias-key.sh` + test; G3 runbook `alta-y-baja-de-agente.md` y purgar de `authentication.md`/`container-adapters.md` los pasos de editar JSON a mano | `test_rollout_pty.py` verde con el mapping nuevo; runbook ejecutado por otro que no lo escribió |
| **OpenCode/MiniMax** | `docs/`, verificaciones mecánicas | M1 censo: cero rutas de edición manual restantes sobre `container-aliases.json`/`manifests`; M2 `docs/mapa-de-ficheros.md` marcando los derivados; M3 correr y reportar G-SNAP-4 y el estado de `deploy/runtime/fleet-snapshot.mjs` (**reportar, no borrar**: `deploy/**` es fila NADIE) | salida de comandos pegada, sin prosa |

## 8. Demo final (la prueba de efecto que exige el protocolo)

Alias de prueba `probeta` (tenant Steven, room `grp.steven`, harness codex, contenedor `ctrl-infra`, user `dev` — reusa infraestructura existente para no inventar contenedores).

1. El dueño corre **un `INSERT` en `agents` + uno en `memberships`**. Nada más se toca.
2. `export-fleet-snapshot.py` → `git diff --stat` muestra **un solo fichero**: `ops/flota.json`.
3. `regenerate-fleet.sh` → aparecen `manifests/probeta.yaml`, `generated/systemd/cauce-v3-alias-probeta.service`, unit de contenedor, entrada en `container-aliases.json`, en `telegram-runtime/config.json` y en `generated/fleet.json`. `git diff --stat` = exactamente el conjunto derivado, cero ediciones a mano.
4. `ops/scripts/validate.sh` en verde (pegado).
5. `cauce probeta aprovisionar` → listado de las piezas con **modos y dueños** (nunca valores de secretos).
6. **Efecto real**: se arranca la unit y se pega `SELECT alias, lease_until > now() FROM connection_leases WHERE alias='probeta';` con lease activo + un mensaje entregado de ida y vuelta.
7. **Baja**: `UPDATE agents SET enabled=false` → re-export (probeta salta de `fleet` a `retired`) → regenerar **purga** `probeta.yaml` y su unit → `validate.sh` verde → `cauce probeta retirar` revoca hash y cert → se pega el rechazo del gateway al reconectar con esas credenciales.
8. **Criterio de aceptación global**: en el `git log -p` de la demo, **todo fichero cambiado tiene un generador que lo reproduce**. Si algo se editó a mano, el gate del paso 4 lo habría puesto rojo.

## 9. Riesgos y qué NO hacer en esta ronda

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Un solo byte distinto en `container-aliases.json` invalida `OPERATIONS.sha256`, los `source-digest` y el release PTY firmado | Fase A (identidad byte a byte antes de cambiar el input) + re-firmar una sola vez, no por iteración |
| R2 | La flota pasa de 11 a 14: `physical-fleet-gate` exigirá los contenedores de gaia/heraclito/tales y puede bloquear la ventana | Comprobar existencia física ANTES de commitear. Si falta un contenedor, **lo que está mal es la fila de BD**: el dueño la deshabilita. Jamás se parchea el fichero para cuadrar |
| R3 | iza (hermes→openclaw) y kant (dev→stev) cambian bytes de units de agentes VIVOS: regenerar y reinstalar podría tumbarlos | Reconciliar iza/kant en la BD o en la realidad primero; tratar la unit regenerada como cambio de despliegue, no cosmético; no instalar units fuera de la ventana con el dueño |
| R4 | Un alias nuevo con `dockerHost` fuera de `{local,kratos}` rompe `Fleet.load` en pleno release | Chequeo en el exportador: falla en el export, no en el release |
| R5 | Tenant fuera del enum del schema (caso Pablo) | El generador falla ruidoso; se corrige la BD o se amplía el enum **deliberadamente** |
| R6 | Que el snapshot filtre material secreto | El exportador solo lee `agents`/`memberships`/`role_policies`; test que prohíbe claves `token|secret|password` en `ops/flota.json` |

**Prohibido esta ronda**: borrar `container-aliases.json` o `manifests/` (20 consumidores, release firmado, digests pineados); unificar los 3 parsers duplicados (se pinean con G-SNAP-4); añadir columnas/migraciones para el residuo físico (`packages/store/migrations/**` es fila NADIE — para eso está el overlay); que el CLI escriba en la BD de producción; tocar `/opt`, `/etc/cauce-v3` o instalar units fuera de la ventana FASE 3 con el dueño; meter timestamp u hostname en el snapshot (mata la idempotencia); correr el exportador dentro de un gate (los gates siguen herméticos); y "arreglar" el drift editando los ficheros — **el drift se resuelve siempre en la BD**.

**Round 2 (fuera de alcance, anotado)**: fusionar `container-aliases.json` y `manifests/` dentro del snapshot y repuntar los consumidores; versionar en git el trío `/opt/.../fleet_source.py` + watchdog; añadir el chequeo de paridad al watchdog de 10 minutos; `cauce alta` haciendo el INSERT tras confirmación.
---

## ANEXO A — Desviaciones BD↔físico medidas HOY (el libro de reconciliación, §7-K1)

**RESPONDIDO por el dueño (28-08)**: (1) argos = **OPENCLAW** (¡ambos lados estaban mal: BD decía hermes, físico decía claude!); (2) iza = **openclaw@claw-miguel** (BD tenía razón); (3) kant = rama host en la torre, confirmado (es el encargado de su infraestructura); (4) gaia/heraclito/tales **corren HOY en la VPS** — hay que darles representación física (alias+manifest+unit) en la ronda, no deshabilitarlos. Tabla original de evidencia:

| # | Alias | La BD dice | El físico (json/manifest/units) dice | Pregunta al dueño |
|---|---|---|---|---|
| 1 | **argos** | harness=`hermes` | harness=`claude` (resto de colocación coincide) | ¿Qué arnés corre argos DE VERDAD? El que sobre, se corrige |
| 2 | **iza** | `openclaw` @ `claw-miguel`, user `claw` | `hermes` @ `ws-humanizar`, user `dev` | Desvío TOTAL de colocación, ambos internamente consistentes — ¿cuál es la real? |
| 3 | **kant** | `host:kratos`, user `stev`, `/var/lib/cauce-v3/aliases/kant` | `ctrl-infra`, user `dev` (el json esconde la rama host tras `registryContainer`) | La BD parece la buena (patrón host) — confirmar |
| 4 | **gaia/heraclito/tales** | 3 agentes ENABLED (Jhon×2, Miguel) | SIN representación física en este host (ni alias, ni manifest, ni unit) | ¿Dónde corren físicamente? ¿otro host (placement) o deshabilitar en BD? |
| 5 | *(estructural)* | — | `stateDirectory` significa DOS cosas distintas (ruta en contenedor vs StateDirectory de systemd) | Resuelto en el diseño (§3): dos nombres internos, wire intacto |

## ANEXO B — Mediciones que sostienen el diseño
- **Derivabilidad**: de ~30 campos por agente, solo **3 son residuo físico real** (`dockerHost` — hoy solo salva; `registryContainer` — hoy solo kant; `healthContainer` divergente) → overlay de 3 claves. TODO lo demás: BD 1:1 o fórmula pura de `(alias, harness)`.
- **historicalAliases muere**: lo reemplaza `retired` derivado de `agents.enabled=false` — la baja vuelve a ser 1 UPDATE.
- **Credenciales**: no existe alta-de-agente unificada; el molde correcto es `provision-terminal-client.sh` (emisor de certs con allowlist quemada a 2 CN → se generaliza con allowlist derivada del snapshot). 6 piezas encadenadas en `cauce <alias> aprovisionar` (§5); única pieza no generable: el token de BotFather.
- **Consumidores**: ~20 lectores de la capa actual mapeados; esta ronda NO los repunta (se genera bit-idéntico primero — Fase A); 4 parsers duplicados se PINEAN (G-SNAP-4), se unifican en round 2.
