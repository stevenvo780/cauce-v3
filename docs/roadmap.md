# Roadmap — qué falta

Este documento no describe cómo funciona el sistema (eso es [arquitectura.md](arquitectura.md)) sino lo que le falta al **producto**, priorizado. Aquí no se afirma el estado de ninguna instalación: eso se acredita con las sondas y los censos de [operacion.md](operacion.md), nunca leyéndolo de un `.md`.

## 1. Contextos nativos por harness

El defecto que hay que matar: Cauce reinyecta el contexto completo en cada entrega en vez de dejar que cada arnés lea su fichero nativo una vez. El camino nativo existe detrás de `CAUCE_NATIVE_PROFILE_CONTEXT` y **el flag sigue apagado por defecto**.

**Lo que ya está en el árbol.**

- **Una sola tabla de presupuestos, con la unidad de cada arnés.** `PRESUPUESTOS_DE_CONTEXTO` (`packages/protocol/src/ficheros-del-arnes.ts:296-302`) es la casa única de esos hechos; el tope dejó de ser una constante de un arnés incrustada en el generador.
  - **openclaw**: `TOPES_OPENCLAW`, 60.000 por fichero y 150.000 en total, medidos en unidades UTF-16 (`:277`). Sigue exportado porque el adaptador lo aplica DENTRO del contenedor, donde no hay base de datos que consultar.
  - **codex**: defecto de 32 KiB **en bytes UTF-8** (`TOPE_CODEX_POR_DEFECTO_BYTES`, `:292`) que el hecho MEDIDO por alias (`project_doc_max_bytes`, leído del `config.toml` de cada contenedor) sobrescribe siempre, nunca al revés (`:318-328`). Ese número no se siembra en ninguna tabla SQL: duplicaría un hecho medido por alias y divergiría en cuanto alguien editase un `config.toml`.
  - **claude**: entrada presente y sin cifra — sólo rige el techo nativo de 4 MiB de `MAX_CLAUDE_DOCUMENT_BYTES` (`packages/adapter-sdk/src/context/native-profile-context.ts:38`) hasta que haya un número medido. Es pregunta abierta, no invención.

  Las dos unidades no se mezclan JAMÁS: `TOPES_OPENCLAW` cuenta caracteres y `project_doc_max_bytes` cuenta bytes UTF-8, y confundirlas se equivoca hasta 4× en un manual no ASCII. Lo que Cauce escribe ya estaba acotado en todos los arneses por `AGENT_PROFILE_LIMITS.total` — 24.000 caracteres acumulados (`packages/protocol/src/agent-profile.ts:35`; la tabla completa de topes, `:23-36`); lo que no tenía tope era el fichero **anfitrión**, que es lo que esta tabla cierra.

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
| Flota como datos (alta/baja de agentes trivial) | **Hecho** — alta y baja tocando solo BD+CLI; todo lo demás derivado (manifests, units, config de Telegram, aprovisionamiento mTLS). Ver `arquitectura.md` §4 |
| Contextos nativos por harness | **Pendiente** — flag apagado, bloqueantes en §1 |
| Rotación de credenciales fácil / cuotas inteligentes | **Pendiente** — el recolector de cuotas se queda como referencia hasta que el CLI integral (abajo) lo absorba; no se rehace todavía |
| Permisos dinámicos | **Pendiente** — sin ronda dedicada |
| Terminal/TUI web desde cualquier dispositivo | **En curso** — el CLI ya opera TUIs vía `ops/guardias/cauce-attach`; falta el acceso web (parte del CLI integral) |
| UI clara multi-socio | **En curso** — consola operativa (`/live`, `/observability`, `/messages`); pendiente el mega-refactor (§4) |
| Logs de auditoría de comportamiento | **Pendiente** — no existen hoy; objetivo es detectar contaminación de contextos entre instancias |

**CLI instalable.** Hoy `ops/cli/cauce` es una única fuente que asume el host del stack: deriva rutas locales, habla con systemd por `systemctl --user` y con Docker por el socket local. Falta empaquetarlo como aplicación instalable en cualquier ordenador, con autenticación hacia TUIs y máquinas remotas y consumo de cuotas en tiempo real integrado (reemplaza al recolector de cuotas actual).

**Notificaciones recurrentes por agente.** Sustituye a la idea descartada de Alertmanager, que salió del stack entero. Cualquier agente puede tener mensajes tipo cron encolados a su canal por el bus; generaliza el patrón ya probado del revividor de colas, con su salvaguarda de idempotencia. Primer uso, ya versionado en el árbol: `ops/guardias/cauce-alertas-al-bus.py` consulta `/api/v1/alerts` de Prometheus y publica la entrega al bus, con su par systemd `ops/guardias/systemd/cauce-alertas-al-bus.{service,timer}` y cadencia de 5 min (`OnCalendar=*-*-* *:0/5:00 UTC`). Alternativas evaluadas y descartadas: receptor webhook de Alertmanager; registrar `mcp-fleet-monitor` en el arnés de un alias operador para que investigue con tools. **Lo que falta es la generalización**: hoy la ruta es ese guardia dedicado a alertas, no la capacidad de encolar mensajes tipo cron al canal de cualquier agente.

**Aislamiento por tenant.** Cada tenant en su propio contenedor con carpetas separadas. El checkout de git hoy lo comparten todos los tenants; el aislamiento real exige credenciales por-tenant dentro del contenedor de cada uno (el patrón de directorio de secretos por alias que ya usa el supervisor, `ops/scripts/container-adapter-supervisor.sh:825`, falta generalizarlo).

## 4. Calidad continua

- **Molienda estricta por zonas.** Las zonas duras ya están dentro de `lint:estricto:zonas` (`package.json:30`), y como `pnpm lint` lo encadena (`package.json:24`), cualquier regresión en ellas es roja de gate, no deuda anotada. Lo que queda pendiente es **fundir la enumeración**: `lint:estricto` (árbol entero, sin `--max-warnings 0`) y `lint:estricto:zonas` conviven, y mientras la lista sea manual una zona nueva entra al repo sin gate hasta que alguien la añada.
- **Traducción de comentarios a inglés**: en curso por zonas. Pendientes: barrido de restos en español en las zonas ya tocadas, y los tests de consola, relay y bridge. Regla que dejó esta deuda: una molienda masiva de comentarios **debe regenerarse sobre `main` fresco** y, tras integrarla, hay que auditar los marcadores de los arreglos recientes antes de desplegar — una ola generada sobre copias viejas ya revirtió una condición de negocio y sólo la cazó el test del contrato.
- **Particiones >800 líneas**: el trinquete (`scripts/calidad.mjs`, umbral 800) mantiene una lista de excepciones congeladas en `scripts/calidad-base.json` que solo puede bajar. Recontar antes de citar cualquier número, porque la lista baja sola con cada partición:
  ```bash
  node -e "const b=require('./scripts/calidad-base.json');console.log(Object.keys(b.lineas).length,Object.keys(b.fechas).length,Object.keys(b.comentarios).length)"
  ```
  Candidatos vivos, por tamaño: `packages/store/test/agent-output-postgres.test.ts` (2.700 líneas), `services/gateway/src/terminal.plugin.test.ts` (2.034), `ops/tests/container-supervisor.test.mjs` (1.709), `ops/container-runtime/cauce-container-runtime.py` (1.650), y varios más entre 800 y 1.400 líneas. Recontar con `wc -l` antes de citarlos: bajan con cada partición.
- **Cirugía de dominios** (planificada, sin ronda asignada): mover `flota/` a su propio dominio, subir consola a la raíz del repo, repartir `ops/` — con checklists derivados de [grafo.md](grafo.md) para no romper consumidores.
- **Mega-refactor de consola**: deep-link en `/terminal`, que desbloquearía borrar los casos especiales del router; regenerar `grafo.md`; resolver los asserts-sobre-texto de los tests de consola. Incluye sustituir las sondas CDP quemadas en código por el patrón «un agente con Chrome revisa legibilidad» (las sondas de contraste, tipografía y CSP se conservan para ese uso).

## 5. Deuda anotada

- **La poda de `attachments_v1` en `messages.body` no tiene índice para su predicado.** El único índice sobre `messages(created_at)` es parcial sobre `origin IS NOT NULL`, así que en estado estacionario cada ejecución es un recorrido secuencial. Falta la migración con el índice parcial `created_at WHERE body ? 'attachments_v1'`. **Por qué no es un cambio suelto:** toda migración nueva obliga además a enseñarle su versión a `packages/store/test/secret-handoff-layer.ts` — los `down/` de 031 en adelante se niegan a correr mientras haya una migración posterior registrada, así que las suites que revierten la suya tienen que despegar antes las capas de encima. Es tolerable mientras tanto porque el barrido tiene cadencia y cota propias (ver [threat-model.md](threat-model.md)).
- **`container-aliases.json` y `manifests/` sin fusionar en el snapshot único.** Más de treinta ficheros de `ops/` los parsean por su cuenta (`generate-container-aliases.py`, `rollout_pty_lib.py`, `update-alias-config.py`, `gate-collector.mjs`, `container_ops_digest.py`, `generate-telegram-config.py`, `validate.sh`, …), así que un cambio de forma se paga en todos ellos.
- **El CLI no hace el INSERT del alta.** No existe subcomando `alta`: el despachador sólo expone `aprovisionar` y `retirar` (`ops/cli/cauce:1439-1440`), y `aprovisionar` cubre las credenciales. El alta en base de datos la sigue **imprimiendo como instrucción** al operador desde dentro de `cmd_aprovisionar` — un INSERT en `agents`+`memberships` y luego regenerar `ops/flota.json` (`ops/cli/cauce:1092`).
- **`ops/tests/gate-collector.test.mjs` y su gemelo `ops/tests/fake-gate-collector.mjs`** siguen siendo la única cobertura de lo suyo, igual que el resto de los tests de `ops/` que un censo llamó huérfanos: la nota de «no los limpies» sigue vigente.
- **`fleet_source.py` y su watchdog no están versionados**: viven instalados fuera del árbol, así que ningún gate del repo los ve.

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
