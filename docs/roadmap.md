# Roadmap — qué falta

Este documento no describe cómo funciona el sistema (eso es [arquitectura.md](arquitectura.md)) sino lo que le falta al **producto**, priorizado. Aquí no se afirma el estado de ninguna instalación: eso se acredita con las sondas y los censos de [operacion.md](operacion.md), nunca leyéndolo de un `.md`.

## 1. Inmediato post-deploy

Lo que sigue sin cerrar de la propia ventana de despliegue, antes de dar la fase por terminada. Incluye el defecto que hay que matar en contextos por harness: Cauce reinyecta el contexto completo en cada entrega en vez de dejar que cada arnés lea su fichero nativo una vez. El camino nativo existe detrás de `CAUCE_NATIVE_PROFILE_CONTEXT` y **el flag sigue apagado por defecto**.

**Verificado ítem por ítem contra el árbol el 30-08-2026 y re-verificado el 2026-09-27** (deltas aplicados abajo; líneas movidas actualizadas). Cada punto lleva su veredicto: *cerrado*
con el commit que lo cerró, *sigue en pie* con la línea que lo demuestra, o *no verificado* cuando el
ítem habla del estado de la flota (kratos, la base de producción) y no del árbol. Un roadmap que da
por abierto lo que ya está cerrado hace que alguien gaste una ronda en arreglar lo arreglado, así que
lo que no se comprobó se dice, no se supone. Esto no afirma el estado de ninguna instalación: eso se
acredita con las sondas y los censos de [operacion.md](operacion.md), nunca leyéndolo de este `.md`.

- **Rollout del launcher PTY con siega** — *sigue en pie, sólo el despliegue.* El código ya está en el
  árbol: `ops/pty-agent/cauce-pty-launcher.sh:709` define `reap_orphan_agents` y `:743` la invoca
  (commit `0a08de4`; líneas actualizadas 2026-09-27). Lo que falta es llevarlo a los alias; **no comprobé qué release corre hoy la
  flota**, eso es estado de kratos.
- **Gateway acepta agentes `enabled=false`** — **CERRADO** por `dcdf7a9`. `routes/core.ts:365` y `:367` y
  `routes/core/http.ts:46` pasan `requireEnabledAgent: true` al `acquireLease`, y
  `packages/store/src/repository/deliveries/claims.ts:59-61` lo aplica dentro de la transacción del
  lease (`StoreError('forbidden', 'delivery consumer is disabled')`; líneas actualizadas 2026-09-27).
- **Contextos nativos por harness** — el flag sigue OFF; de los seis puntos anotados, cuatro
  cerrados y dos sin verificar:
  1. **CERRADO en esta ronda.** El tope dejó de ser una constante de OpenClaw incrustada en el
     generador. `packages/protocol/src/ficheros-del-arnes.ts` declara ahora
     `PRESUPUESTOS_DE_CONTEXTO` (`:296-302`), una tabla única de hechos por arnés con la **unidad** de cada uno:
     - **openclaw** (`TOPES_OPENCLAW`, hoy 90.000 por fichero y 200.000 en total —subidos a
       propósito por `a7859070`, eran 60.000/150.000—, medidos en unidades UTF-16). `TOPES_OPENCLAW` sigue exportado porque el
       adaptador lo aplica DENTRO del contenedor, donde no hay base de datos que consultar.
     - **codex** lleva un defecto de 32 KiB **en bytes UTF-8** (`TOPE_CODEX_POR_DEFECTO_BYTES`) que el hecho MEDIDO por alias
       (`project_doc_max_bytes`, leído del `config.toml` de cada contenedor) sobrescribe siempre;
       nunca al revés, y ese número no se siembra en ninguna tabla SQL: duplicaría un hecho medido
       por alias y divergiría en cuanto alguien editase un `config.toml`.
     - **claude** queda con la entrada presente y sin cifra —sólo rige el techo nativo de 4 MiB de
       `MAX_CLAUDE_DOCUMENT_BYTES`— hasta que el dueño dé un número medido: es pregunta abierta, no
       invención.

     Las dos unidades no se mezclan JAMÁS: `TOPES_OPENCLAW` cuenta caracteres y
     `project_doc_max_bytes` cuenta bytes UTF-8, y confundirlas se equivoca hasta 4× en un manual no
     ASCII. Lo que Cauce escribe ya estaba acotado en todos los arneses por
     `AGENT_PROFILE_LIMITS.total` — 24.000 caracteres acumulados (`packages/protocol/src/agent-profile.ts:35`;
     la tabla completa de topes, `:23-36`); lo que no tenía tope era el fichero **anfitrión**, que
     es lo que esta tabla cierra.
  2. **No verificado.** El precipicio de expectativa vencida. El fichero cambió por `6ea006e`,
     `c483075` y `c09c67c`, y hoy tiene un camino `revalidate()` y escritura compare-and-swap
     (`escribirEnDiscoRealSiCoincide`, `native-profile-context.ts:109`) que no existían cuando se
     anotó. **No ejecuté el escenario de dos entregas seguidas** que produce el precipicio, así que
     no lo doy por cerrado ni por abierto.
  3. **CERRADO** por `a3a157a`. La allowlist del supervisor sí conoce la clave:
     `ops/scripts/container-adapter-supervisor.sh:161` la valida (`^[01]$`) y `:885` la propaga al
     entorno del alias (líneas actualizadas 2026-09-27).
  4. **CERRADO.** El supervisor deriva ahora **las dos** generaciones, no una:
     `ops/scripts/container-adapter-supervisor.sh:478-483` calcula `container_generation` con el
     sha256 **entero** (64 hex) de `id\0started\0restart\0init_starttime`, y calcula
     `container_presence_generation` = sha256 de `id|started|restart` truncado a 32 hex, que es
     exactamente la fórmula del launcher (`ops/pty-agent/cauce-pty-launcher.sh:154-159`). El
     consumidor acepta cualquiera de las dos:
     `packages/adapter-sdk/src/context/native-profile-context.ts:485-487` compara el contrato contra
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
  `ops/cli/cauce:452-453` (`systemctl_user_o_avisa`) deriva `XDG_RUNTIME_DIR` de `/run/user/$(id -u)`
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

- **Dos generaciones, no una.** El supervisor deriva `container_generation` con el sha256 **entero** (64 hex) de `id\0started\0restart\0init_starttime` (`ops/scripts/container-adapter-supervisor.sh:478-480`) y `container_presence_generation` = sha256 de `id|started|restart` truncado a 32 hex (`:481-483`), que es exactamente la fórmula del launcher (`ops/pty-agent/cauce-pty-launcher.sh:154`). El consumidor acepta cualquiera de las dos (`packages/adapter-sdk/src/context/native-profile-context.ts:485-487`). Cada una responde a una pregunta distinta y por eso son dos: la larga incluye el arranque del PID 1 y detecta que el **proceso de dentro** se reinició aunque el contenedor no (invalida contextos nativos ya sembrados); la corta identifica la **encarnación del contenedor** que el launcher nombra en el ticket firmado, así que un `docker restart` entre emisión y uso caduca los tickets vivos. Fundirlas en una sola vuelve a abrir uno de los dos agujeros.
- **La allowlist del supervisor conoce la clave**: la valida (`^[01]$`, `:161`), sólo la propaga al entorno del alias si está declarada (`:885`), la rechaza junto a `SHARED_SESSION` y exige arnés claude u openclaw (`:258-262`).

**Lo que falta.**

- **El precipicio de expectativa vencida sigue sin prueba.** El fichero tiene ya un camino `revalidate()` (`packages/adapter-sdk/src/context/native-profile-context.ts:228`) y escritura compare-and-swap (`escribirEnDiscoRealSiCoincide`, `:194`), pero el escenario de **dos entregas seguidas** contra una expectativa vencida no está cubierto por un test que lo fije.
- **El orden de encendido es parte del diseño, no una recomendación.** Abrir el perfil del alias en la consola registra la expectativa; encender `CAUCE_NATIVE_PROFILE_CONTEXT=1` en ese canario va DESPUÉS, jamás antes.
- **Rollout por canario, no por flota.** El tope por fichero de openclaw vetaba la siembra entera de un alias cuando un fichero no gestionado de su workspace se medía igual; está arreglado en el protocolo (`comprobarTopes` ignora los ficheros que no se escriben) con test. Falta el procedimiento de convergencia: pin del bundle en el canario, verificación, y sólo entonces el resto.

## 2. Capas pendientes del contexto

Lo que la consola NO deja editar del contexto de un agente, y por qué. La consola enlaza a esta sección por su nombre.

### Herramientas · qué puede usar y qué no

**Lo pedido.** Ver y cambiar qué herramientas, MCP y skills tiene permitidos cada agente.

**Por qué todavía no.** Cauce no guarda esto en un punto único: está repartido entre el `settings.json` del contenedor, la allowlist de `managed-settings` y la configuración de cada arnés. Ninguno se almacena en el store central ni se expone con autoridad en el gateway, así que una pantalla que dijera «estas son tus herramientas» estaría adivinando.

**Qué falta.** Definir la fuente canónica de herramientas, y separar de forma segura la exposición de herramientas respecto de credenciales o secretos en configuraciones compartidas: hoy los dos viven en los mismos ficheros, y servir uno sin el otro no es un filtro de campos, es un rediseño.

### Prompts · falta acordar qué son

**Lo pedido.** Editar «los prompts» del agente desde la web.

**Por qué todavía no.** El concepto abarca dos implementaciones que no se parecen: los preámbulos que el adaptador genera en cada entrega (derivados, no editables) y las plantillas de rol reutilizables (un catálogo que sí se persistiría en el store). Abrir un editor sin decidir cuál de las dos toca produce una pantalla que edita algo que el agente no lee.

**Qué falta.** Decidir si la edición aplica a plantillas de rol reutilizables o a directivas dinámicas, y dejarlo escrito antes de construir la pantalla.

## 3. Producto — los 7 puntos de la visión

Estado de cada punto de [doctrina-del-dueno.md](doctrina-del-dueno.md) §La visión:

| Punto | Estado |
|---|---|
| Flota como datos (alta/baja de agentes trivial) | **Hecho** — demo probeta superada: alta y baja tocando solo BD+CLI, todo lo demás derivado (manifests, units, telegram, aprovisionamiento mTLS). Persiste el hallazgo de seguridad del gateway (§1). La coletilla de baja propia está CERRADA: `register-agent-identity.py` tiene `--revoke` (`fe6d234c`) y `cauce retirar` lo encadena (paso 2b). Ver `arquitectura.md` §4. |
| Contextos nativos por harness | **Pendiente** — subpuntos §1 1,3,4,5 cerrados (TOPES 90K/200K), flag OFF |
| Rotación de credenciales fácil / cuotas inteligentes | **Pendiente** — `quota-collector` se queda como referencia hasta que el CLI integral (abajo) lo absorba; no se rehace todavía |
| Permisos dinámicos | **Pendiente** — sin ronda dedicada |
| Terminal/TUI web desde cualquier dispositivo | **En curso** — el CLI ya opera TUIs vía `ops/guardias/cauce-attach`; falta el acceso web (parte del CLI integral) |
| UI clara multi-socio | **En curso** — consola operativa (`/live`, `/observability`, `/messages`); pendiente el mega-refactor (§4) |
| Logs de auditoría de comportamiento | **Pendiente** — guardia de contaminación existe (`contaminacion-de-contexto.ts` + endpoint audit); detectar patrones entre instancias sigue pendiente |

**CLI instalable.** Hoy `ops/cli/cauce` (~1.442 líneas) es una única fuente rescatada que asume el host del stack: deriva rutas locales, habla con systemd por `systemctl --user` y con Docker por el socket local, y corre solo desde esta VPS. Falta empaquetarlo como aplicación instalable en cualquier ordenador sin depender de la torre, con autenticación hacia TUIs/máquinas remotas y consumo de cuotas en tiempo real integrado (reemplaza a `quota-collector`). Centro de mando sigue siendo siempre esta VPS; multi-servidor ya tiene precedente (kant).

**Notificaciones recurrentes por agente.** Sustituye a la idea descartada de Alertmanager, que salió del stack entero. Cualquier agente puede tener mensajes tipo cron encolados a su canal por el bus; generaliza el patrón ya probado del revividor de colas, con su salvaguarda de idempotencia. Primer uso, ya versionado en el árbol: `ops/guardias/cauce-alertas-al-bus.py` consulta `/api/v1/alerts` de Prometheus y publica la entrega al bus, con su par systemd `ops/guardias/systemd/cauce-alertas-al-bus.{service,timer}` y cadencia de 5 min (`OnCalendar=*-*-* *:0/5:00 UTC`). Alternativas evaluadas y descartadas: receptor webhook de Alertmanager; registrar `mcp-fleet-monitor` en el arnés de un alias operador para que investigue con tools. **Lo que falta es la generalización**: hoy la ruta es ese guardia dedicado a alertas, no la capacidad de encolar mensajes tipo cron al canal de cualquier agente.

**Aislamiento por tenant.** Cada tenant en su propio contenedor con carpetas separadas. El checkout de git hoy lo comparten todos los tenants; el aislamiento real exige credenciales por-tenant dentro del contenedor de cada uno (el patrón de directorio de secretos por alias que ya usa el supervisor, `ops/scripts/container-adapter-supervisor.sh:825`, falta generalizarlo).

## 4. Calidad continua

- **Molienda estricta por zonas — las cuatro zonas rojas ya están promovidas al gate.** `packages/protocol/src` (20 problemas medidos entonces), `packages/mcp-fleet-monitor/src` (15), `packages/store/src` (136) y `services/gateway/src` (346) cierran hoy en `0 problems` y están dentro de `lint:estricto:zonas` en `package.json`, que además cubre `packages/protocol/test`, `packages/store/test`, `packages/adapter-sdk/src` y `packages/adapter-sdk/test` sobre las zonas que ya tenía (`console`, `services/{terminal-relay,telegram-bridge,dispatcher}`, `tests`). Como `lint` encadena `lint:estricto:zonas`, cualquier regresión en ellas es roja de gate, no deuda anotada. Lo que queda pendiente es fundir la enumeración: `lint:estricto` (árbol entero, sin `--max-warnings 0`) y `lint:estricto:zonas` conviven, y mientras la lista sea manual una zona nueva entra al repo sin gate hasta que alguien la añada.
- **Traducción de comentarios a inglés**: en curso por zonas (tracking ROTO 2026-09-27: `ordenes/opencode-minimax*.md` borrados de refilón por `79967f29`, no restaurados; `ordenes/` = 1 fichero). Cerradas: `adapter-sdk/src`, `dispatcher`, `deploy`, `scripts`, `pty-agent`, las 18 herramientas de `ops/guardias/`. Pendientes: barrido de restos (~51 comentarios en español medidos en la última ronda) en las zonas ya tocadas; tests de consola/relay/bridge; `packages/adapter-sdk/test/**` (zona exclusiva de minimax-1, en curso con la partición del punto siguiente). Regla que dejó esta deuda: una molienda masiva de comentarios **debe regenerarse sobre `main` fresco** y, tras integrarla, hay que auditar los marcadores de los arreglos recientes antes de desplegar — una ola generada sobre copias viejas ya revirtió una condición de negocio y sólo la cazó el test del contrato.
- **Particiones >800 líneas**: el trinquete de calidad (`scripts/calidad.mjs`, umbral 800) mantiene una lista de excepciones congeladas en `scripts/calidad-base.json` que solo puede bajar — hoy 19 ficheros en `lineas`, 11 en `fechas`, 1.130 entradas acotadas en `comentarios` (SUBIÓ desde 950: revisar trinquete, 2026-09-27) (recontar con `node -e "const b=require('./scripts/calidad-base.json');console.log(Object.keys(b.lineas).length,Object.keys(b.fechas).length,Object.keys(b.comentarios).length)"` antes de citar cualquier número: la lista baja sola con cada partición). `shared-session.test.ts` (5.444 líneas, el que fue el mayor del repo) **ya está partido** en 18 ficheros por `fd10fea`; verificado el 30-08-2026. `ops/pty-agent/cauce_pty_agent.py` (2.659 líneas, y que el roadmap citaba mal como `ops/pty_agent/…`) **ya no existe**: hoy es el paquete `ops/pty-agent/cauce_pty_agent/` (13 módulos `.py`, máx 785) y ha salido de la lista congelada. Quedan, fuera de la lista o como candidatos futuros: `packages/store/test/agent-output-postgres.test.ts` (2.700), `services/gateway/src/terminal.plugin.test.ts` (2.034), `ops/tests/container-supervisor.test.mjs` (1.703), `ops/container-runtime/cauce-container-runtime.py` (1.648), y varios más entre 800-1.400 líneas (cifras 2026-09-27).
- **Cirugía de dominios** (planificada, sin ronda asignada): mover `flota/` a su propio dominio, subir consola a la raíz del repo, repartir `ops/` — con checklists derivados de `docs/grafo.md` para no romper consumidores.
- **Mega-refactor de consola**: deudas acumuladas de la revisión de vistas — deep-link en `/terminal` que desbloquearía borrar ~180 LOC más y los casos especiales del router; regenerar `docs/grafo.md`; resolver los 74 asserts-sobre-texto de los tests de consola. Incluye adoptar el patrón "un agente con Chrome revisa legibilidad" en vez de sondas CDP quemadas en código (las 6 sondas de contraste/tipografía/CSP se conservan para ese uso).

## 5. Deuda anotada

**Verificada ítem por ítem contra el árbol el 30-08-2026 y re-verificada el 2026-09-27**, con el mismo criterio del §1.

- **CERRADO** por `eeac106`, y la paridad se mantiene hoy: los dos generadores purgan units huérfanas
  — `ops/scripts/generate-container-units.py:273-274` retira `cauce-v3-container-*.service` y su
  `.env.example`, `ops/scripts/generate-units.py:108-109` retira `cauce-v3-alias-*.service`. Sigue
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
  hora** (ver [threat-model.md](threat-model.md)). Lo recogen W5/W3b; OJO 2026-09-27: `041` ya la ocupa el diario W5, siguiente libre `042`.
- **CERRADO** por `fe6d234c` (cambio de veredicto 2026-09-27). `ops/scripts/register-agent-identity.py`
  tiene modo de baja (`--revoke`, `revoke()` `:308`) y `cauce retirar` lo encadena (paso 2b, `:1386`).
- **Sigue en pie pero YA CON REFERENTE (2026-09-27).** «Fila NADIE del residuo físico BD↔realidad»:
  tabla de sectores en `ordenes/00-PROTOCOLO.md:34` + `ops/private/credentials/README.md:9`; el
  "residuo BD↔realidad" concreto sigue sin check accionable.
- **Sigue en pie (peor, 2026-09-27).** `container-aliases.json` y `manifests/` sin fusionar en el snapshot único: 58
  ficheros de `ops/` lo referencian (no "más de veinte") (`generate-container-aliases.py`,
  `rollout_pty_lib.py`, `update-alias-config.py`, `gate-collector.mjs`, `container_ops_digest.py`,
  `generate-telegram-config.py`, `provision-hermes-runtime.sh`, `validate.sh`, …).
- **Sigue en pie.** `/opt/.../fleet_source.py` y su watchdog no están versionados:
  `git ls-files | grep fleet_source` no devuelve nada.
- **Sigue en pie.** `cauce alta` no hace el INSERT: `ops/cli/cauce:1083` lo sigue **imprimiendo como
  instrucción** al operador («alta = 1 INSERT en agents+memberships, luego export-fleet-snapshot.py»).
- **Sigue en pie.** `ops/tests/gate-collector.test.mjs` y su gemelo `ops/tests/fake-gate-collector.mjs`
  siguen ahí; el resto de los 7 tests de `ops/` que un censo llamó huérfanos siguen siendo la única
  cobertura de lo suyo, así que la nota de «no los limpies» sigue vigente.
- **CERRADO** por `80dcbf7`. El `AuthError 401` sin sesión de consola ya tiene test que lo fija como
  contrato: `services/gateway/src/password-auth.test.ts:379` comprueba que `GET /v3/status` sin
  cookie responde 401 (y `:415`, `:432` cubren la cookie inválida y la caducada; líneas 2026-09-27).

## 6. Decisiones de diseño pendientes

Cada una tiene un diseño propuesto y ninguna se aplica a ciegas.

1. **Fan-in: errores de arnés no reintentables terminan al primer intento.** Sesión nativa inexistente, «no rollout found» o `auth_permanent` son terminales; hoy queman los tres intentos y el fan-in espera a que TODAS las ramas acaben, así que un arnés roto convierte una respuesta en minutos de silencio.
2. **Repetición de arista en el mismo root.** El primer salto sin tope de abanico es legítimo (el «pregúntale a todos»), pero la REPETICIÓN de la misma arista dentro del mismo root debe endurecerse: hoy un segundo abanico duplica preguntas.
3. **El rechazo `fanout_exceeded` debe decir cuándo la arista ya se recorrió en este root.** Con el texto actual el agente lo lee como «el destino no recibió la pregunta» y se lo cuenta así al operador.
4. **Carteles de diagnóstico del arnés por un canal aparte del reply.** Hoy entran al fan-in como si fueran texto del agente.
5. **DLQ: clasificar por firma de error** («No conversation found», «no rollout found») → reintento seguro con hilo nuevo, en vez de revivir a mano entregas sin tipificar.
6. **No redesplegar el runtime con cadenas humanas abiertas.** El dispatcher sabe cuántas raíces hay en vuelo; además hay que persistir los logs del runtime fuera del `json-file` del contenedor, que se pierde con la recreación.
7. **`cred-guard`: la señal honesta es una renovación de prueba, no la fecha de caducidad.** «OK con access vencido» oculta una credencial muerta, y el contraejemplo simétrico también existe: un CLI que renueva al usar aparece «vencido» durante días y funciona.
8. **Adaptador codex: ante `-32600 no rollout found`, caer a hilo nuevo en el mismo intento** en vez de gastar el intento.
9. **Sesión nativa inexistente = crear una nueva.** Cualquier renovación de TUI o limpieza deja mapeos fantasma en el `sessions.json` del arnés; hoy el adaptador muere tres veces antes de que alguien lo limpie a mano.
10. **Re-medición en caliente de los hechos del runtime.** El `runtime_facts` del bundle del pty-agent se carga UNA vez al arrancar (`ops/pty-agent/cauce_pty_agent/runtime_facts.py`) y viaja en el HELLO (`ops/pty-agent/cauce_pty_agent/agent.py`), así que cualquier reinicio del adaptador deja la medición obsoleta y la consola responde 503 al escribir un perfil («el runtime no publicó hechos medidos del alias»). El resto del pipeline relay→gateway ya refresca presencia periódicamente: el único eslabón congelado es éste. Diseño: portar la medición del launcher a una función del agente, añadir `state_directory` al bundle, re-medir antes del HELLO y comprobar en el bucle de mantenimiento forzando reconexión SÓLO si cambian los hechos Y no hay sesiones abiertas; **preservar la invariante de generación** (nunca adoptar una nueva) y no inventar panel tmux. Mientras no exista, la regla operativa es la de [operacion.md](operacion.md): tras reiniciar un adaptador, reiniciar su PTY.
11. **Modelos del arnés que no resuelven.** Un alias cuya configuración de compactación apunta a un modelo que el registro del arnés no declara pierde el turno entero ya computado. El parche propio de `ops/patches/` degrada la compactación a warning, no la arregla: hay que declarar los modelos en el registro del arnés o retirar los alias no resolubles de sus defaults. Y el parche sólo protege donde está aplicado — aplicarlo a medias es el escenario contra el que advierte `ops/patches/README.md`.
