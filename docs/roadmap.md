# Roadmap — qué falta

Cauce V3 corre en producción desde el primer despliegue real (estado a 28-08-2026: commit `caa8789a`, esquema 024→037, 10 contenedores desde el compose canónico del repo). Este documento no describe cómo funciona el sistema (eso es `arquitectura.md`, `flota-y-participantes.md`, `grafo.md`) sino lo que falta, priorizado.

## 1. Inmediato post-deploy

Lo que sigue sin cerrar de la propia ventana de despliegue, antes de dar la fase por terminada.

**Verificado ítem por ítem contra el árbol el 30-08-2026.** Cada punto lleva su veredicto: *cerrado*
con el commit que lo cerró, *sigue en pie* con la línea que lo demuestra, o *no verificado* cuando el
ítem habla del estado de la flota (kratos, la base de producción) y no del árbol. Un roadmap que da
por abierto lo que ya está cerrado hace que alguien gaste una ronda en arreglar lo arreglado, así que
lo que no se comprobó se dice, no se supone.

- **Rollout del launcher PTY con siega** — *sigue en pie, sólo el despliegue.* El código ya está en el
  árbol: `ops/pty-agent/cauce-pty-launcher.sh:763` define `reap_orphan_agents` y `:798` la invoca
  (commit `0a08de4`). Lo que falta es llevarlo a los alias; **no comprobé qué release corre hoy la
  flota**, eso es estado de kratos.
- **Gateway acepta agentes `enabled=false`** — **CERRADO** por `dcdf7a9`. `routes/core.ts:238-240` y
  `routes/core/http.ts:46` pasan `requireEnabledAgent: true` al `acquireLease`, y
  `packages/store/src/repository/deliveries/claims.ts:58-60` lo aplica dentro de la transacción del
  lease (`StoreError('forbidden', 'delivery consumer is disabled')`).
- **Contextos nativos por harness** — el flag sigue OFF; de los seis puntos anotados, cuatro
  cerrados y dos sin verificar:
  1. **CERRADO en esta ronda.** El tope dejó de ser una constante de OpenClaw incrustada en el
     generador. `packages/protocol/src/ficheros-del-arnes.ts` declara ahora
     `PRESUPUESTOS_DE_CONTEXTO`, una tabla única de hechos por arnés con la **unidad** de cada uno:
     - **openclaw** conserva EXACTAMENTE sus cifras de hoy (`TOPES_OPENCLAW`, 60.000 por fichero y
       150.000 en total, medidos en unidades UTF-16). `TOPES_OPENCLAW` sigue exportado porque el
       adaptador lo aplica DENTRO del contenedor, donde no hay base de datos que consultar.
     - **codex** lleva un defecto de 32 KiB **en bytes UTF-8** que el hecho MEDIDO por alias
       (`project_doc_max_bytes`, leído del `config.toml` de cada contenedor) sobrescribe siempre;
       nunca al revés, y ese número no se siembra en ninguna tabla SQL: duplicaría un hecho medido
       por alias y divergiría en cuanto alguien editase un `config.toml`.
     - **claude** queda con la entrada presente y sin cifra —sólo rige el techo nativo de 4 MiB de
       `MAX_CLAUDE_DOCUMENT_BYTES`— hasta que el dueño dé un número medido: es pregunta abierta, no
       invención.

     Las dos unidades no se mezclan JAMÁS: `TOPES_OPENCLAW` cuenta caracteres y
     `project_doc_max_bytes` cuenta bytes UTF-8, y confundirlas se equivoca hasta 4× en un manual no
     ASCII. Lo que Cauce escribe ya estaba acotado en todos los arneses por
     `AGENT_PROFILE_LIMITS.total = 24_000`; lo que no tenía tope era el fichero **anfitrión**, que
     es lo que esta tabla cierra.
  2. **No verificado.** El precipicio de expectativa vencida. El fichero cambió por `6ea006e`,
     `c483075` y `c09c67c`, y hoy tiene un camino `revalidate()` y escritura compare-and-swap
     (`escribirEnDiscoRealSiCoincide`, `native-profile-context.ts:109`) que no existían cuando se
     anotó. **No ejecuté el escenario de dos entregas seguidas** que produce el precipicio, así que
     no lo doy por cerrado ni por abierto.
  3. **CERRADO** por `a3a157a`. La allowlist del supervisor sí conoce la clave:
     `ops/scripts/container-adapter-supervisor.sh:175` la valida (`^[01]$`) y `:891` la propaga al
     entorno del alias.
  4. **CERRADO.** El supervisor deriva ahora **las dos** generaciones, no una:
     `ops/scripts/container-adapter-supervisor.sh:492-493` calcula `container_generation` con el
     sha256 **entero** (64 hex) de `id\0started\0restart\0init_starttime`, y `:495-497` calcula
     `container_presence_generation` = sha256 de `id|started|restart` truncado a 32 hex, que es
     exactamente la fórmula del launcher (`ops/pty-agent/cauce-pty-launcher.sh:152-157`). El
     consumidor acepta cualquiera de las dos:
     `packages/adapter-sdk/src/context/native-profile-context.ts:470-472` compara el contrato contra
     `runtimeGeneration` **o** `presenceGeneration`. Cada una responde a una pregunta distinta y por
     eso son dos: la larga incluye el arranque del PID 1 y detecta que el **proceso de dentro** se
     reinició aunque el contenedor no (invalida contextos nativos ya sembrados); la corta identifica
     la **encarnación del contenedor** que el launcher nombra en el ticket firmado, así que un
     `docker restart` entre emisión y uso caduca los tickets vivos. Fundirlas en una sola vuelve a
     abrir uno de los dos agujeros.
  5. **CERRADO.** Los 5 tests de `shared-session` rojos en `adapter-sdk` ya no existen como tales: el
     fichero de 5.444 líneas se partió en 18 (commit `fd10fea`) y la suite corre **689 tests**. En
     reposo pasa entera; el rojo que aparecía **bajo carga** ya tiene arreglo en el árbol y falta
     reconfirmarlo — ver la nota al final de esta sección.
  6. **No verificado.** Lado Claude sin alias elegible en producción: es estado de la flota.
- **Revivir o decidir jarvis** — **no verificado**: estado de la flota y de la base de producción.
- **El cuello de botella OpenClaw** — **no verificado**: sin diagnosticar, y no es comprobable contra
  el árbol.
- **Poda de historiales de BD** y **GC del registry de contenedores** — **no verificado**: requieren
  la base y el registry de producción.
- **Limpiar `prod.env`** — *la cuenta de 9 claves no es de fiar.* `prod.env` vive en el servidor (en
  el árbol sólo está `ops/config/prod.env.example`), así que la lista no se puede recontar aquí; pero
  **`CAUCE_COMPOSE_OVERRIDE_MANIFEST` sí tiene consumidor** — `ops/scripts/compose.sh:43-58` lo trata
  como control de compose. `SHADOW_*` sí da cero ocurrencias en todo el árbol. Recontar antes de
  borrar nada.
- **Archivar `/opt/cauce-v3` y `/etc/cauce-v3/compose-overrides/`** — **no verificado**: rutas del
  servidor.
- **Montaje rw de `ws-zeus` sobre el árbol de producción** — **no verificado**: decisión del dueño
  sobre un montaje del host.
- **`cauce <alias> on` sin `XDG_RUNTIME_DIR` bajo `su stev`** — **CERRADO** por `5f80ed1`.
  `ops/cli/cauce:517-519` (`systemctl_user_o_avisa`) deriva `XDG_RUNTIME_DIR` de `/run/user/$(id -u)`
  y `DBUS_SESSION_BUS_ADDRESS` del socket, y si el `systemctl --user` falla lo imprime con la pista
  (`systemctl --user -M stev@`) y devuelve 1. Ya no hay `|| true` que se lo trague.
- **Las 2 entregas atascadas de hegel** — **no verificado**: estado de la base de producción.
- **Techo fijo de 55 min en turnos fusionados del paste-runner — cerrado en esta ronda.** La opción
  de correlación+gracia y su constante se retiraron: un turno fundido que sigue generando ya no se
  corta ni pone el pane en cuarentena; el único límite que queda es el presupuesto del turno.
- **Vigía de flota ciego a un alias que reclama trabajo y nunca lo empieza — cerrado en esta
  ronda.** El chequeo sólo miraba entregas `pending`; un adaptador que muere justo tras reclamar
  deja sus filas en `leased`/`accepted` sin llegar nunca a `dead_letters`, y esa forma quedaba
  invisible. `check_claimed_not_started` cubre ahora ambos estados con una antigüedad mínima (con
  control negativo: una reclamación sana no dispara la alerta), y la consola distingue ese caso de
  `idle` en vez de leerlo como «Libre».

> **Nota — el rojo sensible a la carga de `test:unit` está atacado en el árbol.** Lo medido el
> 30-08-2026 fue esto: con cuatro suites de consola compitiendo,
> `pnpm --filter @cauce/adapter-sdk run test` cayó dos veces seguidas (`# fail 2` y `# fail 1` de
> 689), siempre en `a receipt cannot release the harness while its transport send never settles`; en
> reposo pasaba entera. La causa —estado compartido entre procesos de test— está corregida: cada
> proceso escribe en su propia raíz (`testStateRoot(...)`, usado en todo `packages/adapter-sdk/test/**`)
> y cada socket tmux lleva pid y UUID (`cauce-*-${process.pid}-${randomUUID()}`), así que dos
> corridas simultáneas ya no se pisan el directorio ni el servidor tmux. Lo que falta es la
> confirmación empírica: **no volví a correr la suite bajo carga en esta ronda — no lo probé.**

## Capas pendientes del contexto

Lo que la consola NO deja editar del contexto de un agente, y por qué. Esta prosa vivía dentro del
bundle de la SPA: la pantalla la enseñaba, pero nadie podía versionarla ni discutirla fuera del
navegador. Vive aquí, y la consola enlaza a esta sección por su nombre.

### Herramientas · qué puede usar y qué no

**Lo pedido.** Ver y cambiar qué herramientas, MCP y skills tiene permitidos cada agente.

**Por qué todavía no.** Cauce no guarda esto en un punto único: está repartido entre el
`settings.json` del contenedor, la allowlist de `managed-settings` y la configuración de cada arnés.
Ninguno se almacena en el store central ni se expone con autoridad en el gateway, así que una
pantalla que dijera «estas son tus herramientas» estaría adivinando.

**Qué falta.** Definir la fuente canónica de herramientas, y separar de forma segura la exposición
de herramientas respecto de credenciales o secretos en configuraciones compartidas: hoy los dos
viven en los mismos ficheros, y servir uno sin el otro no es un filtro de campos, es un rediseño.

### Prompts · falta acordar qué son

**Lo pedido.** Editar «los prompts» del agente desde la web.

**Por qué todavía no.** El concepto abarca dos implementaciones que no se parecen: los preámbulos
que el adaptador genera en cada entrega (derivados, no editables) y las plantillas de rol
reutilizables (un catálogo que sí se persistiría en el store). Abrir un editor sin decidir cuál de
las dos toca produce una pantalla que edita algo que el agente no lee.

**Qué falta.** Decidir si la edición aplica a plantillas de rol reutilizables o a directivas
dinámicas, y dejarlo escrito antes de construir la pantalla.

## 2. Producto — los 7 puntos de la visión

Estado de cada punto de `docs/flota-y-participantes.md` §La visión:

| Punto | Estado |
|---|---|
| Flota como datos (alta/baja de agentes trivial) | **Hecho** — demo probeta superada: alta y baja tocando solo BD+CLI, todo lo demás derivado (manifests, units, telegram, aprovisionamiento mTLS). Persiste el hallazgo de seguridad del gateway (§1) y `register-agent-identity.py` sin modo de baja propio (`cauce retirar` debería encadenarlo). |
| Contextos nativos por harness | **Pendiente** — 4 bloqueantes descritos en §1, flag OFF |
| Rotación de credenciales fácil / cuotas inteligentes | **Pendiente** — `quota-collector` se queda como referencia hasta que el CLI integral (abajo) lo absorba; no se rehace todavía |
| Permisos dinámicos | **Pendiente** — sin ronda dedicada |
| Terminal/TUI web desde cualquier dispositivo | **En curso** — el CLI ya opera TUIs vía `cauce-attach`; falta el acceso web (parte del CLI integral) |
| UI clara multi-socio | **En curso** — consola operativa (`/live`, `/observability`, `/messages`); pendiente el mega-refactor (§3) |
| Logs de auditoría de comportamiento | **Pendiente** — no existen hoy; objetivo es detectar contaminación de contextos entre instancias |

**CLI instalable**: hoy es una única fuente rescatada (`ops/cli/cauce`, ~1.446 líneas) que corre solo desde esta VPS. Falta: empaquetarlo como app instalable en cualquier ordenador sin depender de la torre, con autenticación hacia TUIs/máquinas remotas y consumo de cuotas en tiempo real integrado (reemplaza a `quota-collector`). Centro de mando sigue siendo siempre esta VPS; multi-servidor ya tiene precedente (kant).

**Notificaciones recurrentes por agente**: sustituye a la idea descartada de Alertmanager. Cualquier agente puede tener mensajes tipo cron encolados a su canal por el bus; generaliza el patrón ya probado del revividor-de-colas (con su salvaguarda de idempotencia). El primer uso previsto es el Zeus guardián: un timer que lee alertas de Prometheus y publica al bus (~100 líneas, patrón ya existente) — alternativas evaluadas: receptor webhook de Alertmanager, o registrar `mcp-fleet-monitor` en el harness de zeus para que investigue con tools.

**Aislamiento por tenant**: cada tenant en su propio docker con carpetas separadas. El checkout de git hoy lo comparten los 4 tenants; el aislamiento real exige credenciales por-tenant dentro del contenedor de cada uno (patrón `/opt/cauce-v3-secrets/<alias>` ya existe, falta generalizarlo).

## 3. Calidad continua

- **Molienda estricta por zonas — las cuatro zonas rojas ya están promovidas al gate.** `packages/protocol/src` (20 problemas medidos entonces), `packages/mcp-fleet-monitor/src` (15), `packages/store/src` (136) y `services/gateway/src` (346) cierran hoy en `0 problems` y están dentro de `lint:estricto:zonas` en `package.json`, que además cubre `packages/protocol/test`, `packages/store/test`, `packages/adapter-sdk/src` y `packages/adapter-sdk/test` sobre las zonas que ya tenía (`console`, `services/{terminal-relay,telegram-bridge,dispatcher}`, `tests`). Como `lint` encadena `lint:estricto:zonas`, cualquier regresión en ellas es roja de gate, no deuda anotada. Lo que queda pendiente es fundir la enumeración: `lint:estricto` (árbol entero, sin `--max-warnings 0`) y `lint:estricto:zonas` conviven, y mientras la lista sea manual una zona nueva entra al repo sin gate hasta que alguien la añada.
- **Traducción de comentarios a inglés**: en curso por zonas (`ordenes/opencode-minimax.md`, `opencode-minimax-2.md`). Cerradas: `adapter-sdk/src`, `dispatcher`, `deploy`, `scripts`, `pty-agent`, las 18 herramientas de `ops/guardias/`. Pendientes: barrido de restos (~51 comentarios en español medidos en la última ronda) en las zonas ya tocadas; tests de consola/relay/bridge; `packages/adapter-sdk/test/**` (zona exclusiva de minimax-1, en curso con la partición del punto siguiente).
- **Particiones >800 líneas**: el trinquete de calidad (`scripts/calidad.mjs`, umbral 800) mantiene una lista de excepciones congeladas en `scripts/calidad-base.json` que solo puede bajar — hoy 19 ficheros en `lineas`, 11 en `fechas`, 950 entradas acotadas en `comentarios` (recontar con `node -e "const b=require('./scripts/calidad-base.json');console.log(Object.keys(b.lineas).length,Object.keys(b.fechas).length,Object.keys(b.comentarios).length)"` antes de citar cualquier número: la lista baja sola con cada partición). `shared-session.test.ts` (5.444 líneas, el que fue el mayor del repo) **ya está partido** en 18 ficheros por `fd10fea`; verificado el 30-08-2026. `ops/pty-agent/cauce_pty_agent.py` (2.659 líneas, y que el roadmap citaba mal como `ops/pty_agent/…`) **ya no existe**: hoy es el paquete `ops/pty-agent/cauce_pty_agent/` (10 módulos, ninguno por encima de 664 líneas) y ha salido de la lista congelada. Quedan, fuera de la lista o como candidatos futuros: `packages/store/test/agent-output-postgres.test.ts` (2.700), `services/gateway/src/terminal.plugin.test.ts` (2.034), `ops/tests/container-supervisor.test.mjs` (1.728), `ops/container-runtime/cauce-container-runtime.py` (1.650), y varios más entre 800-1.400 líneas.
- **Cirugía de dominios** (planificada, sin ronda asignada): mover `flota/` a su propio dominio, subir consola a la raíz del repo, repartir `ops/` — con checklists derivados de `docs/grafo.md` para no romper consumidores.
- **Mega-refactor de consola**: deudas acumuladas de la revisión de vistas — deep-link en `/terminal` que desbloquearía borrar ~180 LOC más y los casos especiales del router; regenerar `docs/grafo.md`; resolver los 74 asserts-sobre-texto de los tests de consola. Incluye adoptar el patrón "un agente con Chrome revisa legibilidad" en vez de sondas CDP quemadas en código (las 6 sondas de contraste/tipografía/CSP se conservan para ese uso).

## 4. Deuda anotada

**Verificada ítem por ítem contra el árbol el 30-08-2026**, con el mismo criterio del §1.

- **CERRADO** por `eeac106`, y la paridad se mantiene hoy: los dos generadores purgan units huérfanas
  — `ops/scripts/generate-container-units.py:258-263` retira `cauce-v3-container-*.service` y su
  `.env.example`, `ops/scripts/generate-units.py:120-124` retira `cauce-v3-alias-*.service`. Sigue
  mereciendo vigilancia en cambios futuros, pero hoy no es deuda abierta.
- **Quedó fuera.** La poda de `attachments_v1` en `messages.body` corre sin índice para su predicado
  (el único sobre `messages(created_at)` es parcial sobre `origin IS NOT NULL`), así que en estado
  estacionario cada ejecución es un recorrido secuencial; el índice parcial
  `created_at WHERE body ? 'attachments_v1'` no se añadió y sigue pendiente como migración propia.
  **Por qué no se añadió en esta ronda:** toda migración nueva obliga además a enseñarle su versión a
  `packages/store/test/secret-handoff-layer.ts` —los `down/` de 031 en adelante se niegan a correr
  mientras haya una migración posterior registrada, así que las suites que revierten la suya tienen
  que despegar antes las capas de encima—, y eso queda fuera del sector de escritura de esta ronda.
  Es tolerable mientras tanto porque el barrido tiene cadencia y cota propias: **50 filas cada
  hora**. Lo recogen W5/W3b junto con `041`/`042`, que son las dos siguientes libres.
- **Sigue en pie.** `ops/scripts/register-agent-identity.py` no tiene modo de baja: la única mención
  a revocar es el texto de error de `:276` («revocarla antes de registrar esta»). La revocación de
  identidad mTLS sigue siendo manual y `cauce retirar` no la encadena.
- **No verificado.** «Fila NADIE del residuo físico BD↔realidad» en `packages/store/migrations/**`:
  la cadena `NADIE` no aparece en el árbol y el apunte no dice contra qué compararla. **No pude
  comprobar de qué habla**; o se reescribe con la evidencia o se retira.
- **Sigue en pie.** `container-aliases.json` y `manifests/` sin fusionar en el snapshot único: más de
  veinte ficheros de `ops/` lo parsean por su cuenta (`generate-container-aliases.py`,
  `rollout_pty_lib.py`, `update-alias-config.py`, `gate-collector.mjs`, `container_ops_digest.py`,
  `generate-telegram-config.py`, `provision-hermes-runtime.sh`, `validate.sh`, …).
- **Sigue en pie.** `/opt/.../fleet_source.py` y su watchdog no están versionados:
  `git ls-files | grep fleet_source` no devuelve nada.
- **Sigue en pie.** `cauce alta` no hace el INSERT: `ops/cli/cauce:1186` lo sigue **imprimiendo como
  instrucción** al operador («alta = 1 INSERT en agents+memberships, luego export-fleet-snapshot.py»).
- **Sigue en pie.** `ops/tests/gate-collector.test.mjs` y su gemelo `ops/tests/fake-gate-collector.mjs`
  siguen ahí; el resto de los 7 tests de `ops/` que un censo llamó huérfanos siguen siendo la única
  cobertura de lo suyo, así que la nota de «no los limpies» sigue vigente.
- **CERRADO** por `80dcbf7`. El `AuthError 401` sin sesión de consola ya tiene test que lo fija como
  contrato: `services/gateway/src/password-auth.test.ts:350` comprueba que `GET /v3/status` sin
  cookie responde 401 (y `:386`, `:403` cubren la cookie inválida y la caducada).

## Hallazgos de la revisión post-despliegue (28-08, tras el primer despliegue real)

Ordenados por prioridad; cada uno con su zona. Evidencia y reproducción en el historial de git (`git log --grep 'post-ventana'`).

- **RESUELTO 28-08 · gateway/store (bus)** — *(arreglo en el servidor, commit en main; desplegado con la ventana de la tarde)* `acks.ts:140` responde a un ACK con epoch vigente pero identidad ajena con un frame `error fenced` SIN correlación; el cliente no sabe qué evento descartar y derriba la conexión (bucle medido con zeus: 453 reconexiones WS en 5 min). Arreglo: responder `ack_result receipt:'ownership_lost'` correlacionado, como ya hace `staleTerminalReplay` en `routes/core.ts:520-531`; el cliente ya trata `ownership_lost` bien. Complemento: tope de reenvíos por evento en el cliente.
- **Decidido · segador** — Las entregas en `failed` con `attempt<max_attempts` NO se reintentan por diseño: `failed` es un ACK terminal ya aplicado por el adaptador (invariante probado en `packages/store/test/materialization-crosstenantroom-postgres.test.ts`); el segador solo barre claims vencidos (`leased/accepted/started`). Lo que sí merece ticket: `retryable` en el ACK es `false` por defecto y casi ningún harness lo activa, así que fallos transitorios mueren en el primer intento.
- **RESUELTO · adapter-sdk (bus, complemento)** — El recibo correlacionado `ownership_lost` elimina sólo el ACK durable superado, degrada su registro a `failed/retryable` y deja avanzar el siguiente intento. La suite conserva el control negativo: una respuesta inconclusa no drena el ACK. La implementación y el control negativo entraron en `c7345da9`; hoy los fija `client-outbox-and-errors.test.ts`.
- **P0 · plano PTY** — `cauce-v3-pty@heraclito` y `@tales`: unit `inactive` pero agente PTY vivo y conectado al relay. Un `systemctl start` rutinario duplicaría el agente y reabriría el bucle del relay. No arrancarlas hasta desplegar el launcher con la siega (`ops/pty-agent/cauce-pty-launcher.sh` ya la trae; la release instalada `ops-pty-home-20260825` no).
- **Sin resolver · incidente 08:49Z** — Los 4 supervisores recibieron SIGKILL simultáneo desde fuera; el médico queda exonerado (no existe como unit ni en la torre ni en el VPS, y no escribió bitácora ese día) aunque su bug de substring era real y ya está cerrado. Única pista: a esa hora 5 instancias IA trabajaban como root en el VPS. Si se repite: `journalctl _COMM=kill` y auditd sobre `kill()` a los MainPID de `cauce-v3-container-*`.
- **P1 · torre (kratos)** — Instalación vieja de la flota bajo `stev`: drop-ins `pty@dedalo`/`pty@midas` (agentes de Pablo, que no existen), units `container-{atlas,kratos,dedalo}` inactivas, y `salva` corriendo el release `bus-v3-20260814-umbral-espera`. Entra en el rollout del release de adaptadores; purgar lo de Pablo.
- **P1 · release de adaptadores** — El `container-aliases.json` instalado (release 20260825) difiere del canónico en 5 alias (argos/iza/tales harness, gaia/heraclito nuevos, y kant mapeado al contenedor de argos). Rollout con las units generadas en `ops/generated/container-systemd/rootless/` (G1 + `rollout-pty`).
- **P1 · observabilidad — Alertmanager retirado, cerrado en esta ronda.** Alertmanager salió del stack entero: `deploy/compose.alertmanager.yaml`, `ops/observability/alertmanager.yaml` y `ops/scripts/provision-alertmanager-config.py` se borraron, y `ops/observability/prometheus.yaml`/`alerts.yaml` ya no lo referencian (ni el bloque `alerting:`, ni el job de scrape, ni la alerta `CauceAlertmanagerDown`). La vía que decidió el dueño —notificaciones tipo cron por agente— es la que sigue pendiente de construir (ver §2, «Notificaciones recurrentes por agente»); mientras tanto ninguna alerta crítica de Prometheus llega a un humano por esta ruta.
- **P1 · producto (origin_relay)** — La única fila de `adapter_outbox` con `adapter='console'` lleva días sin consumidor: el worker de `origin_relay` filtra por `telegram`. O el encolado traduce el adaptador, o se registra un worker para `console` (`CAUCE_RELAY_ADAPTERS`).
- **P2 · dead letters** — 576 entregas, 64 origin_relay y 1405 wake en cartas muertas sin triaje; las 2 de hegel de hace 12 días siguen en `failed` (el segador no las toca). Triaje por lotes con los humanos de cada tenant.
- **P3 · seguridad de ws-zeus** — El contenedor del dueño monta `/var/run/docker.sock` y el árbol del repo (material de producción) en rw, con `claude --dangerously-skip-permissions`. Retirar el socket o proxy con scopes; decidir `ro` para lo que prod monta.
- **P3 · host** — `docker builder prune` periódico (~15 GB reclamables; disco al 83%). CI nocturno ya corre como root (el mix root/stev lo tumbaba a los 17 s).

## Post-perfiles (28-08 por la tarde)

- **Hecho · flota 12/12 al día** — los 12 alias locales en `bus-v3-20260828-perfiles2` + supervisor `ops-main-20260828`, unit activa, lease vivo y perfil sembrado (kratos/atlas con config aislada por alias). `applied_revision` avanza cuando cada arnés consuma su primer turno real (contrato 035); hasta entonces es NULL aunque los ficheros ya estén en disco.
- **Hecho · cirugía de mounts** — `agv2-jhon-heraclito-oc` y `ctrl-infra` recreados con binds persistentes (.claude/.claude.json; .openclaw/clawd): sus datos de arnés vivían en capa efímera y el supervisor nuevo lo cazó (fail-closed, trabajando como fue diseñado). Los contenedores viejos quedan PARADOS como respaldo: `*-pre-mounts-20260828` — purgar cuando el dueño valide. El workspace de argos sigue ya la convención `{home}/clawd` (BD: user=dev, home=/home/dev).
- **P1 · imagen claw:latest** — hornea claude 2.1.150 y el supervisor solo acepta el binario en `~/.local/bin` o `~/.npm-global`: cada recreación exige reinstalar la versión esperada + symlink (hecho a mano en heraclito). Hornear versión y ruta en la imagen.
- **P1 · rollout perfiles3 a argos** — el tope por fichero de openclaw vetaba TODA la siembra de argos porque su TOOLS.md (117 KB, no gestionado) se medía igual; arreglado en protocolo (`comprobarTopes` ignora ficheros que no se escriben) con test. Falta: bundle `perfiles3`, pin de argos y verificación; el resto de la flota puede converger al mismo bundle sin prisa.
- **Nota · tests realineados a la flota real** — `b4bc7b9d` (borra migraciones-ficción) dejó 3 tests presuponiendo membresías que ya no siembra ninguna migración; ahora cada test siembra lo suyo (patrón topología).

## Validación final con workflow (28-08 noche, Sonnet×5 + Opus adversarial)

- **Arreglado en el acto · redes de ctrl-infra** — la cirugía de mounts recreó el contenedor con 1 de sus 5 redes (docker run no hereda redes múltiples): healthcheck en rojo (streak 1152) y sin alcance a su docker-proxy ni a ws-zeus/ws-prizma/ws-humanizar/claw. Reconectadas las 4 (`docker network connect`), healthy con streak 0. Regla nueva del runbook de cirugías: capturar `NetworkSettings.Networks` ANTES de recrear y reconectarlas después.
- **Arreglado · respaldo NAS (7 días caído)** — `vps-humanizar-backup` abortaba a diario: ruta vieja `/datos/workspaces/cauce-v3` (el repo vive bajo `zeus/`) y rutas de Pablo inexistentes. Corregido en `/usr/local/sbin/vps-humanizar-backup-to-nas` (steven→`/datos/workspaces/zeus`, pablo fuera del ciclo con nota; respaldo del script en `.bak-20260828`); corrida manual lanzada. **Punto ciego pendiente (decisión dueño):** el monitor de frescura solo vigila el respaldo de la BD, no el del NAS — cubrir ambos.
- **Arreglado · cauce-cred-guard (334 rojos desde el 21-08)** — la fila `claude/socrates` vigilaba una credencial MUERTA de un harness que socrates no usa (codex según BD); retirada del inventario con nota (la credencial NO se tocó). Guard en verde: `problemas=0 compartidas=0`.
- **Arreglado · CI local mudo** — moría en `dubious ownership` (árbol chowneado a stev hoy 21:19 vs unit como root): `safe.directory` a nivel `--system` y relanzado; el gate completo corre ahora.
- **Limpieza** — unit fantasma `cauce-v3-openclaw-gateway@argos` (12 días failed, sin fichero) purgada con reset-failed.
- **Decisión dueño · dovecot** — muerto desde el 13-08 (status 89), proyecto de correo ajeno a cauce: no lo toqué.
- **Nota** — las descripciones de las units instaladas contradicen la BD en argos/iza/kratos (harness viejo); se corrige solo con el rollout de units generadas ya pendiente en P1.
- **Verificado por Opus además**: bus sano de verdad (argos trabajando durante el incidente de redes), respaldo de BD del plano de control OK con restauración aislada verificada, árbol limpio y pusheado.

## Incidente TUI de consola (28-08 noche) — resuelto

- **Síntoma**: ninguna TUI abría en la vista de la consola desde el deploy de las 14:52 (última buena: 27-08 00:52). El relay rechazaba todo attach con `forbidden 4403`; auditoría: `terminal.session.consume → deny, reason=target_placement_changed, cohort=[]`.
- **Causa raíz (contrato roto entre emisión y verificación)**: la emisión guarda `terminal_sessions.container` como ID FÍSICO del contenedor (presence.container_id del registro vivo — lo que el relay usa para atar sesión↔agente), pero `currentSessionPolicy` lo comparaba contra `agents.container_name` (NOMBRE lógico de la BD). Dominios distintos ⇒ desigualdad siempre ⇒ deny universal. Entró con el plano nuevo de consola (c7345da9) + la flota-como-datos (K1) en el mismo deploy.
- **Arreglo**: la policy compara ahora contra la presencia viva del registry (misma fuente que la emisión); deniega solo cuando el registry SABE dónde vive el alias y no es el contenedor emitido — 'ambiguous' (rotación de relay) lo gobierna el fencing 409 y 'unknown' lo corta el attach. 91/91 del plano en verde; el test de rotación existente corrigió el primer intento del fix.
- **Lección**: el check no tenía NINGÚN test que cruzara emisión↔policy con datos reales (los 5 inspectores del workflow tampoco lo vieron; lo destapó Steven usando la vista). Añadir un caso e2e emisión→consume con placement de BD real.
- **Hito (29-08 00:52Z) · CI nocturno VERDE de punta a punta por primera vez** — typecheck+lint+unit+pty+validate completos sobre main (87efc53c). Hasta hoy el gate paraba en lint y ocultaba los pasos restantes (arreglo de la torre 13f2ecf0) y el harness del supervisor moría sin HOME bajo systemd (87efc53c). Pendiente humano: abrir la vista TUI (verifica el fix en vivo) y abrir el perfil de un agente en la consola (registra la expectativa; DESPUÉS encender CAUCE_NATIVE_PROFILE_CONTEXT=1 en ese canario — jamás antes).
- **Incidente (29-08) · la ola de traducción pisó el P0 del bus** — `ff6d89e6` (comentarios ES→EN ola 1/5, generada en la torre sobre copias viejas) revirtió la condición `!row.claim_live` de acks.ts; el propio test del contrato lo cazó en la suite de red y se re-aplicó en el acto (con redeploy). Los otros cinco fixes de la noche sobrevivieron (auditados por marcador). **Práctica nueva: tras integrar cualquier molienda masiva, auditar los marcadores de los fixes recientes antes de desplegar; las olas de traducción deben regenerarse sobre main fresco.**

## Incidente 503 al aplicar perfiles desde la consola (29-08) — resuelto

- **Síntoma (dueño)**: `PUT /v3/console/tenants/:t/agents/:a/perfil` → 503 "el runtime no publicó hechos medidos del alias", en TODOS los agentes, hasta lo más básico.
- **Cadena**: la consola exige medir el runtime vivo antes de escribir (prepareRuntime→factsFor). Los facts los publica el pty-agent, que los MIDE UNA VEZ al arrancar escaneando /proc del contenedor por el proceso del adaptador con identidad exacta (CAUCE_ALIAS+CAUCE_CONTAINER_GENERATION+CAUCE_STATE_DIR+HOME), exigiendo `len(observed)==1` (`ops/pty-agent/cauce-pty-launcher.sh:579`).
- **Causa raíz A (universal, hoy)**: al reiniciar TODOS los adaptadores hoy (rollouts de bundles), cambió su generación y las mediciones puntuales de los PTY quedaron obsoletas → factsFor undefined → 503 en toda la flota. **Reparado**: reinicio de los 10 PTY (re-miden contra la generación actual). Regla operativa: tras reiniciar un adaptador, reiniciar su PTY (adaptador primero, luego PTY — el ticket HMAC y los facts se atan a la generación).
- **Causa raíz B (claude/codex sin aislar)**: zeus/socrates/tales/heraclito no exportaban CLAUDE_CONFIG_DIR/CODEX_HOME (corren en su default sin config aislada), así que la medición no capturaba la ruta del perfil → 503 permanente. **Reparado (c210ec10)**: el supervisor exporta el default explícito ($HOME/.claude|.codex), byte-idéntico en comportamiento, con test. zeus/socrates verificados exportando y midiendo OK. Verificación: 9/9 aliases locales con PTY producen facts.
- **Bugs colaterales cazados**: la ola ES→EN de dev había corrompido el fixture del supervisor (MOUNT_RW 'true'→'1', bloque MOUNT_* cruzado, CAUCE_SEMBRAR_PERFIL '1'→'0') al colapsar líneas; restaurados.
- **FIX PERMANENTE PENDIENTE (diseño listo, opción B del análisis)**: que el pty-agent RE-MIDA en caliente en vez de una sola vez, para que ningún reinicio de adaptador vuelva a dejar la medición obsoleta. El pipeline relay→gateway ya refresca presencia cada 10s; el único eslabón congelado es `runtime_facts` del bundle, que se carga una sola vez al arrancar (`ops/pty-agent/cauce_pty_agent/runtime_facts.py:104-105`) y viaja en el HELLO (`ops/pty-agent/cauce_pty_agent/agent.py:223-224`). Puntos de inserción, ya sobre el paquete (el monolito `cauce_pty_agent.py` no existe; recomprobar los números con `grep -n`): portar la medición (heredoc de `ops/pty-agent/cauce-pty-launcher.sh:434-618`) a una función del agente; añadir `state_directory` al bundle; re-medir en `_serve()` antes del HELLO (`agent.py:191`) y chequear en `_maintain()` (`session.py:388`) forzando reconexión SOLO si cambian los facts Y no hay sesiones abiertas; PRESERVAR la invariante de generación (nunca adoptar una nueva) y no inventar pane tmux (tmux_cwd=None). Tests: ops/pty-agent/tests/test_runtime_facts.py, test_presencia_home.py. Hacerlo con calma/con zeus — toca el plano PTY.

## Auditoría intensiva de la UI (29-08, 5 auditores en paralelo por feature) — hallazgos y arreglos

Base de suites toda verde (consola 1383, gateway 472, relay 186, bridge 259): los fallos que el dueño nota están en caminos SIN test. Bugs reales verificados, por impacto:

**ARREGLADOS (alto impacto, este commit):**
- **A1 · sesión se cae por hipo de red** — `statusOf` (auth-session.ts) priorizaba `error` sobre una sesión ya establecida: un 500/timeout/blip en el poll de 60 s o al volver a la pestaña desmontaba TODA la consola (perdía vista, scroll, formularios). Ahora el fail-closed solo rige la comprobación inicial; un vencimiento real llega como authenticated:false (200) y ese sí lleva al login. Test nuevo.
- **A2 · la TUI se reabre sola** — el guardián de auto-apertura (SessionStage.tsx) usaba un useRef por montaje que se reseteaba al cambiar de pestaña (GridContainer usa key=id); una TUI cerrada a mano se reabría y un 403 se reintentaba. Ahora lee el campo durable `liveTuiAttempted` (que ya se escribía pero nadie leía).
- **A3 · «Dead letters» subcuenta** — el facade (facades.ts) omitía los `failed` del conteo dead, contradiciendo al store, la tabla y Mensajes. Corregido + test.
- **A4 · un cambio de rol EXITOSO parpadea un error falso** — `confirmarAccion` (ConfigPage.tsx) limpiaba `pendiente` DESPUÉS del await de la relectura; al subir la revisión (1→2) el render lo pintaba como «vencido» («otro operador cambió la config») en una escritura que sí se aplicó. Ahora se limpia antes del await.

**PENDIENTES (requieren decisión de diseño o feature nueva — NO arreglados a ciegas):**
- **Contadores de Colas truncados a 200** (facades vs store): el store ya calcula `totals` globales + `muestra_recortada` pero el facade los pisa recomputando sobre la página. Tensión real: el facade filtra por identidad (recipient/sender) y el store por sala/ACL — reenviar los totals del store mezcla dos políticas de visibilidad. Decidir la política antes de tocar.
- **Búsqueda de auditoría solo mira los 100 eventos cargados** (AuditPanel filtra en cliente): «Ver auditoría» de un relay falla en silencio para traces viejos. Necesita filtro de `trace_id` en el servidor (endpoint nuevo).
- **Topología fusiona agentes de tenants distintos con el mismo alias** (layout-nodes.ts indexa por alias; el `tenants:Set` sugiere que la agrupación puede ser intencional). Mismo patrón en accounts (licenses.ts cross-tenant). Decidir si la identidad visual es alias o tenant+alias.
- **La topología no pinta registered/agent_enabled/off_reason** que el store ya calcula (mejora de UI).
- **«Peor remanente» usa el % efectivo** contradiciendo la propia página de cuotas (ConsumptionSection.tsx) — alinear con la peor ventana.
- **401 en una llamada de datos deja la consola en limbo hasta 60 s** — falta un interceptor global 401→revalidar sesión.
- **Menores**: chain-gates sin UI (solo API); historial de rol se corta en 100 sin avisar; 403 de lectura de /config dice «falta control» (es «read»); editor JSON crudo marca incertidumbre cuando el server normaliza (trim); deep-link a /audit abre Señales; colores de saldo Inventario vs Consumo (<= vs <); porcentajes sin redondear; notice de replay compartido por toda la tabla.

## Incidente del uso intensivo (29-08 tarde) — diagnóstico y reparación

- **zeus mudo**: DOS causas — (a) sesión fantasma (sessions.json apuntaba a una conversación que ya no existe en disco; misma clase que kratos ayer), limpiada con la receta estándar; (b) `input_busy`: el dueño escribió directo en la TUI compartida y dejó texto sin enviar — el adaptador PROTEGE ese texto y no inyecta turnos (comportamiento correcto); se envió el texto pendiente y el flujo volvió. Regla para el dueño: texto a medias en la caja de una TUI compartida bloquea los turnos del bus hasta enviarlo o borrarlo.
- **atlas mudo**: sesión fantasma versión codex («no rollout found for thread…»). Misma receta (limpiar la entrada codex del sessions.json + renovar TUI).
- **argos caótico (trabaja y no contesta)**: la compactación del transcript falla («Unknown model: anthropic/claude-sonnet-5» — defaults.models lo referencia pero providers no lo declara) y en openclaw SIN parchear la excepción se lleva el turno entero YA COMPUTADO. El parche propio `ops/patches/openclaw-turn-compaction-guard.mjs` existía justo para esto pero estaba aplicado A MEDIAS en la flota (claw/claw-miguel/agv2-hegel sí; **ctrl-infra y claw-iza no**) — exactamente el escenario contra el que advierte ops/patches/README.md. Aplicado en los dos que faltaban + gateways reiniciados. **Pendiente de fondo (decisión dueño/zeus): declarar los modelos anthropic en el registro de openclaw o retirar los alias no resolubles de defaults.models — el parche degrada la compactación a warning, no la arregla.**
- **«Errores de cuotas»**: cred-guard en verde (problemas=0, credenciales OK); lo que el dueño vio era la cascada de los turnos comidos por la compactación. El workflow de auditoría barre la tabla de cuotas de consumo por si además hay ventanas agotadas.
- **Patrón recurrente** (3 alias en 2 días): cualquier renovación de TUI/limpieza deja mapeos fantasma en sessions.json. El arreglo de raíz sería que el adaptador tratara «sesión nativa inexistente» como «crear una nueva» en vez de morir 3 veces — candidato a fix en adapter-sdk (decisión con zeus).
- **Verificación post-reparación (15:40Z)**: 16/16 muertas revividas y consumidas (argos 8 done con el parche cargado, atlas 4 done, zeus procesando su cola en serie), journals limpios en los tres. iza queda en `modes=shell` con facts sin medir: no tiene TUI de openclaw viva (condición del agente, no bug) — re-medir su PTY cuando alguien abra su TUI.

## Cierre del incidente del uso intensivo (29-08, auditoría con workflow + reparaciones de la tarde)

La auditoría (3 barridos Sonnet + síntesis Opus) corrigió el cuadro y destapó lo que seguía roto:

- **Argos NUNCA murió**: contestó a las 14:53 y a las 15:23. El «silencio» era la latencia del fan-in, que espera a que TODAS las ramas terminen — y una rama con harness roto quema sus 3 intentos (10–19 min). Además argos le dijo al dueño que jarvis/kant/socrates/zeus «no recibieron la pregunta»: FALSO — el aviso de `fanout_exceeded` no le dice que esa arista ya se recorrió en el mismo root y él lo malinterpretó.
- **Lo que seguía roto a las 15:35 (bucle cada ~8 s) — reparado**:
  1. **Credencial Codex propia de argos vencida desde el 25-08** (el descompartidor la aisló el 13-08 y nadie re-logueó; refresh rechazado, `auth_permanent`). **SOLO EL DUEÑO**: `docker exec -it -u dev ctrl-infra codex login`. NO copiar el auth.json del pool: el refresh de OAuth es de un solo uso.
  2. **Shim agy con E2BIG**: pasaba el prompt por argv; con >200 KB revienta y el 2º fallback muere. Parcheado a stream-json por stdin (backup `.bak-fable-20260829` en ctrl-infra); probado con 300 KB → 200 OK en 28 s. Regla: si se actualiza el shim/agy, verificar que `--input-format stream-json` siga aceptando `{"event":"user",...}`.
  3. **compaction.model de argos** apuntaba a `anthropic/claude-sonnet-5` (irresoluble: los modelos claude-cli no sirven para compactar; zeus alineó la flota a codex el 29-08 02:22 y dejó fuera a argos). Puesto en `antigravity/gemini-3.1-pro` (su codex está muerto hasta el login); **realinear a `codex/gpt-5.6-sol` tras el login del dueño**. openclaw recarga esta config en caliente.
  4. **Verificado E2E**: turno de prueba vía `openclaw agent --agent main` → `livenessState: working`, ganador antigravity/gemini-3.1-pro.
- **Cuotas**: el recolector estaba MUERTO desde el 28-08 16:02Z — corría ad hoc en kratos (nunca fue unidad) y el reinicio de kratos (28-08 14:15 local) se lo llevó; la consola pintaba la última muestra como si fuera fresca. Reinstalado como unidad systemd de usuario (runbook quota-collector.md) + arreglos: el script emitía `groups[]` anidado que el esquema rechaza (400) → ventanas planas (commit 759f1d41); `ai-usage` ya no existe → puente `ops/scripts/ai-live-to-usage.py` sobre cauce-ai-live; bindings reescritos a la forma `{"bindings":[...]}` que el colector parsea (la vieja by_email/by_group no la parseaba nadie; queda en .bak). Verificado: 202, 9 ventanas, todas con account_id.
- **heraclito sin tmux**: instalado en caliente en agv2-jhon-heraclito-oc (sus carteles «spawn tmux ENOENT» contaminaban los fan-in). PENDIENTE: añadirlo a la imagen de esa familia — en caliente se pierde al recrear.
- **El gateway se redesplegó a las 15:07Z EN MEDIO de la ventana** (tumbó los 12 adaptadores a la vez y se llevó los logs json-file de la primera mitad).

**Decisiones de diseño para zeus (de la síntesis, no arregladas a ciegas):**
1. Fan-in: tratar errores de harness NO reintentables (sesión inexistente, no rollout, auth_permanent) como terminales al PRIMER intento — recorta 10-19 min de silencio a segundos.
2. Primer salto sin tope de abanico está bien (el «pregúntale a todos» es legítimo), pero endurecer la REPETICIÓN de arista en el mismo root (el 2º abanico duplicó 6 preguntas en 101 s).
3. El rechazo `fanout_exceeded` debe decir «esa arista ya se recorrió en este root» cuando es el caso (evita que el agente le mienta al dueño).
4. Carteles de diagnóstico del harness por canal aparte del reply (hoy entran al fan-in como texto del agente).
5. DLQ: clasificar por firma de error («No conversation found», «no rollout found») → safe_retry con hilo nuevo; hoy 17 muertas quedaron sin tipificar y hubo que revivirlas a mano.
6. No redesplegar el runtime con cadenas humanas abiertas (el dispatcher sabe cuántas raíces hay en vuelo) + persistir logs del runtime fuera del json-file del contenedor.
7. cred-guard: el estado «OK con access vencido» ocultó la muerte de argos, pero OJO con el contraejemplo salva (5 días «vencido» y funcionando: el CLI renueva al usar). La señal honesta sería una renovación real de prueba, no la fecha — diseñar con calma.
8. adapter codex: ante `-32600 no rollout found`, caer a thread/new en el mismo intento (atlas revivió al instante justo porque el replay le dio hilo nuevo).

## El 503 de perfiles NO estaba arreglado para toda la flota (29-08 noche) — censo y cierre 14/14

El dueño tenía razón: validé el fix de generación con una muestra y di por sano el resto. Censo real por alias (journal del PTY: `accepted alias=X modes=`): **9 de 14 medían; 5 no** — y esos 5 eran los 503 "una y otra vez" del lote de perfiles. Causas y arreglos, por alias:

- **heraclito y tales (VPS)**: el rollout de la tarde les dejó SIN drop-in de release → corrían el lanzador viejo del symlink ops. Al clonarles el conf de zeus descubrí un bug del rollout: `rollout-pty.py` escribe `ExecStart=... <alias>` con el ALIAS LITERAL en el drop-in (heraclito arrancó creyéndose zeus, exit 73 "another PTY launcher owns alias zeus"). Drop-ins reescritos limpios (solo las 2 Environment; el template ya pasa %i). **Pendiente repo**: que rollout-pty.py no hardcodee el alias en el conf.
- **salva y kant (kratos)**: kratos nunca recibió el release d7e89fd8 (quedó excluido del rollout local). Release copiado, drop-ins, salva reiniciada y kant ARRANCADO (su PTY estaba parado). De paso: huérfano de salva del día 27 (lanzador viejo peleando el alias) eliminado.
- **iza (shell-only)**: para openclaw, `harness` exige el puntero canónico `openclaw:<alias>:shared:<alias>` en sessions.json; iza tenía 5 sesiones y ninguna adoptable en automático (el reconciliador solo adopta con exactamente UNA humana). Sembrado el puntero a su sesión de consola (autocorregible: cada turno humano válido lo re-publica). TRAMPA REPETIDA: el primer intento lo PISÓ el adaptador huérfano dentro del contenedor (sobrevive al restart de la unidad y reescribe sessions.json desde su memoria) — receta: stop unidad → **matar adapter-sdk/runtime dentro del contenedor** → editar → start.
- **gaia (sin canal PTY, jamás provisionado)**: alta completa según `ops/runbooks/alta-y-baja-de-agente.md`: `cauce gaia aprovisionar` (token [2] emitido; certs de agente ya existían con modos mal — corregidos a 444/400), cert mTLS `CN=pty-gaia` (RSA 4096, CA /etc/cauce-v3/pki), alias-key HKDF (master real = `/etc/cauce-v3/secrets/terminal-ticket.key`; el runbook dice `pty_master.key`, literal DESACTUALIZADO), `pty/gaia.env`, huella añadida a `/etc/cauce-v3/terminal/pty_agent_identities.json` (el relay lo relee POR CONEXIÓN: sin reinicio), unidad `pty@gaia` anclada al release y arrancada, adaptador `container-gaia` arrancado (lease activo), puntero shared → chat de Miguel. Resultado: `modes=shell,harness`.

**Verificación final: los 14 alias en `modes=shell,harness`.** Pendientes de repo que dejó esta ronda: (1) ExecStart hardcodeado en rollout-pty.py; (2) actualizar el literal del master en el runbook de alta; (3) el `aprovisionar` no emite el cert del plano PTY ni registra la huella — o se añade al CLI o se documenta como paso manual del runbook.

**Cierre de los 3 pendientes de repo del censo (29-08, workflow + revisión adversaria, commit bd9134b8):** rollout-pty emite drop-ins solo-Environment y el template pasa a trampolín `${CAUCE_PTY_OPS_ROOT}`+`%i` (el release ancla también el script del launcher, no solo su entorno); `cauce aprovisionar` cubre el plano PTY ([3b] cert, [3c] huella al registro del relay, [3d] env; idempotente, dry-run, 15 tests); runbook de alta con literales verificados en vivo. Template desplegado a las unidades reales (VPS+kratos, backup .bak-fable-trampolin) y censo re-verificado: 14/14 `shell,harness`. De regalo del revisor: la huella de zeus en el registro del relay estaba con dos puntos (preexistente) — normalizada, zeus reconectó bien.
