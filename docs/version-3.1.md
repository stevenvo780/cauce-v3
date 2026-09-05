# Cauce V3 — versión 3.1

Qué entrega v3.1, cómo se desplegó y qué queda en manos del dueño. Las decisiones
que la gobiernan están en `docs/v3.1-programa.md` (D1–D12); este documento es la cara de salida:
lo que cambia para quien opera, despliega o revisa. El detalle de cada cambio vive en los commits
de `dev` posteriores a la etiqueta `v3.1-snap-base` y en los ADR 007, 008 y 009. Lo que queda
después del cierre —del dueño, recortado por el plan, notas de las reseñas y no probado— está en
`docs/v3.1-pendientes.md`.

## Qué cambia, por capacidad

**Agentes que se pasan ficheros de cualquier tipo.** El borde de delegación transporta
`artifacts` con el mismo inliner y los mismos topes que la salida al origen (`@cauce/protocol`
tiene un único lector de `data:`; `parseDataUri`/`dataUriByteLength`). Una respuesta que sólo trae
un fichero se entrega, no se marca fallida. Los álbumes de Telegram entran como un solo mensaje y
cada miembro se juzga por separado. La consola muestra y descarga adjuntos. Los cuerpos de
adjuntos se podan cuando la respuesta ya los inlineó (fase nueva del dispatcher).

**Credenciales por vías seguras.** Traspaso sellado de secretos entre alias (migración `039`,
ADR 007): sellado X25519 en el adaptador, el secreto nunca entra en el cuerpo, el prompt, la
auditoría, el log ni el ACK; clave de sellado por alias (`CAUCE_SEALING_KEY_PATH`), traspasos con
TTL y poda de vencidos. Redacción en dos fases al publicar (`CAUCE_REDACT_PUBLISH`) con
presupuesto, sobre un patrón único del protocolo.

**Control de contextos.** Presupuesto de contexto por arnés medido en el propio arnés (el tope de
codex sale de su `config.toml` con un lector que nunca diverge en abierto de `tomllib`), auditoría
de lectura y escritura de los ficheros de gobierno con motivo tecleado a mano (8..280 caracteres,
persona atribuida), GET del perfil de sólo lectura, recarga explícita del contexto (operador con
motivo, o el propio alias por mTLS y cuerpo vacío), diario de revisiones del perfil y de los
documentos (migración `041`; sha y bytes, nunca el cuerpo), guardia de contaminación que falla
cerrado cuando otro alias gestiona un bloque del fichero o la huella no es la esperada (ADR 008),
y una guardia de flota que detecta dos alias sobre el mismo inodo o el mismo `$HOME`. El PUT del
perfil pasa las mismas compuertas que la escritura de ficheros (persona atribuida, motivo,
guardia de contaminación, fila de auditoría por resultado). En la consola: motivo obligatorio al
guardar perfil y ficheros, botón «Recargar contexto» con resultado tipado, cuarentena visible que
deshabilita guardar y recargar mientras dure, y un panel «Historial y diff» sobre los diarios de
perfil y de documentos (paginados por cursor, `next_cursor`) con restauración del snapshot
completo por el PUT canónico. Una recarga rechazada por entrega en vuelo nombra hasta veinte
entregas (id, estado, fechas; nunca cuerpos). El motor de contexto nativo sigue apagado hasta que
el dueño lo encienda alias a alias.

**Control real de TUI y PTY desde la consola.** Modo `harness_rw` (ADR 009): tomar y devolver el
teclado de la TUI compartida con motivo obligatorio, operador atribuido y sin comodín en
`grants.json`; mientras hay control tomado el store no arrienda entregas a ese alias (se encolan,
ninguna falla) y el pty-agent rechaza teclado si hay una pegada en vuelo. Arriendo en
`terminal_control_holds` (migración `040`) con techo en SQL, prórroga de la sesión, grabación
asciicast en el relay y métricas del relay. El relay entiende los avisos del agente (`0x26`,
`0x27`) y cierra con `4410` cuando el control se suelta.

**Consola usable en 1080p.** Terminal como página, cajón del agente con ubicación medida, gate de
maquetado con presupuesto vertical (`pnpm qa:layout`), castellano para cada denegación del
gateway, y un motivo tecleado en cada escritura de gobierno.

**Menos duplicación, más cobertura.** Primitivas compartidas en `@cauce/protocol`, `GatewayRepository`
y jobs del núcleo sin copias, arneses sin la siembra inalcanzable, reloj inyectable en el
adapter-sdk, negativos del gateway, del store y de la secuencia PTY, trinquete de cobertura y
`test:core` por commit (`docs/calidad-y-gates.md`).

## Migraciones nuevas

| Migración | Qué crea | Bajada |
|---|---|---|
| `039_secret_handoff.sql` | traspasos sellados de secretos | `down/039_secret_handoff.sql` + `packages/store/test/secret-handoff-layer.ts` |
| `040_terminal_control_holds.sql` | arriendos de control de la TUI | `down/040_terminal_control_holds.sql` + `terminal-control-holds-layer.ts` |
| `041_agent_context_revisions.sql` | diario de revisiones del perfil y de los documentos | `down/041_agent_context_revisions.sql` + `agent-context-revisions-layer.ts` |

Ninguna migración existente se editó. `deploy/Dockerfile` declara
`CAUCE_SCHEMA_COMPATIBLE_THROUGH=041_agent_context_revisions.sql`. Cada `down/` se niega si hay una
versión posterior aplicada: las capas por migración son lo que permite bajar una sin bajar todas.

## Variables nuevas

| Variable | Servicio | Por defecto | Para qué |
|---|---|---|---|
| `CAUCE_TERMINAL_RW_ENABLED` | gateway | `0` | interruptor del modo escribible; apagado hasta que el dueño lo encienda |
| `CAUCE_TERMINAL_CONTROL_HOLD_SECONDS` | gateway | `900` | duración del arriendo de control; nunca por encima del techo de sesión |
| `CAUCE_TERMINAL_SESSION_MAX_TOTAL_SECONDS` | gateway | `3600` (tope `14400`) | techo absoluto de una sesión prorrogada; no puede bajar del TTL de sesión |
| `CAUCE_TERMINAL_RECORDING_DIR` | terminal-relay | sin valor = sin grabación | dónde se escriben las grabaciones (0700/0600) |
| `CAUCE_TERMINAL_RECORDING_MAX_BYTES` | terminal-relay | 32 MiB | tope por grabación; al llegar se marca y deja de escribir |
| `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS` | terminal-relay | `0` | grabar también las shells (sólo tras decisión explícita) |
| `CAUCE_SEALING_KEY_PATH` | adaptadores | ver adapter-sdk | clave de sellado del alias para el traspaso de secretos |
| `CAUCE_REDACT_PUBLISH` | gateway | encendida | redacción en dos fases al publicar; sólo se apaga a propósito |
| `CAUCE_AGENT_WORKSPACE` | adaptadores | workspace declarado del alias | raíz de adjuntos y del modo aparte del CLI |

La grabación de una TUI contiene lo que el agente tenía en pantalla: material sensible. No hay
poda: cuánto se guarda y quién lo borra es decisión del dueño (abajo).

## Cómo se desplegó (dueño)

La secuencia específica de v3.1 fue ésta; `docs/operacion.md §1` conserva el procedimiento vigente
para despliegues posteriores:

1. Fusionar `dev` en `main`; `package.json` raíz en `3.1.0`.
2. Construir las imágenes de runtime y consola y aplicar `039`, `040` y `041` en ese orden (el
   deploy las aplica por nombre; comprobar `CAUCE_SCHEMA_COMPATIBLE_THROUGH`).
3. Desplegar gateway, dispatcher, telegram-bridge, terminal-relay y consola **juntos**. El GET del
   perfil ya no registra la expectativa y el oneshot de arranque
   (`ops/scripts/refresh-profile-expectation.sh`) hace ahora `POST …/context/reload`: los dos
   cambios tienen que estar en línea a la vez o el oneshot de cada contenedor no refresca nada.
4. Copiar los ejecutables de ops que cambian (`ops/guardias/cauce-contexto-colisiones.py` a
   `kratos:~/.local/bin/`, el oneshot a su ruta actual) y regenerar/instalar las unidades desde
   `ops/generated/` (el digest `OPERATIONS.sha256` ya corresponde a este árbol).
5. Publicar el paquete del pty-agent **después** del relay: el relay de v3.1 acepta los avisos
   `0x26`/`0x27`; un relay anterior tira la pierna multiplexada entera al primer tag desconocido.
6. Dejar `CAUCE_TERMINAL_RW_ENABLED=0` y `CAUCE_NATIVE_PROFILE_CONTEXT` apagado; encender el
   modo escribible alias a alias en `grants.json` (sin `"*"`) sólo tras fijar
   `CAUCE_TERMINAL_RECORDING_DIR` y la retención de grabaciones. **Este paso no consta cumplido**:
   el mensaje de `9de3f8ec`, el commit que escribió la fila de esa misma ventana, dice «modo
   escribible de TUI encendido», y la retención sigue abierta abajo. Desde el árbol no se puede
   decidir qué quedó en línea — **no lo probé** contra el sistema vivo. Confirmarlo y escribirlo
   es del dueño (`docs/v3.1-pendientes.md` §1).
7. Escribir la fila de `deploy/HISTORIAL.md`.

`deploy/HISTORIAL.md` registra el despliegue de `7f25fd6f` con smoke verde y dos correcciones de
esa misma tarde: `d2ef50ff`, con smoke verde, y `0b5bf89e`, con smoke ROJO parcial («bus: 0
entregas done» en una ventana sin tráfico; el resto OK, sin rollback). Después vino
`00358416`: la ventana que puso en línea el árbol cerrado de v3.1 —los refactores de ops, consola,
runtime, store, gateway y adapter-sdk, la siega de huérfanos PTY por pidfd, la reconexión ante
sockets sordos, los comandos de operador en DM, el acotado de la exención CSRF y Prometheus en
`[backend, edge]`—. `caf35316` corrigió el bridge de Telegram para reunir en un solo mensaje
las piezas en que el cliente parte un texto de más de 4096 caracteres (antes el agente leía sólo
la primera) y las pruebas del rollout PTY afirman la colocación real de kant. La última fila es
`9b5e2172`, con smoke central verde y correcciones adicionales de consola, Telegram y contexto.
El SDK nuevo está publicado, pero sus pins siguen sin activarse por faltar el principal de la
sonda canary. Ese registro demuestra la ventana central; no sustituye una nueva validación
del estado vivo desde este checkout, y lo que queda por comprobar por efecto después de esa fila
está en `docs/v3.1-pendientes.md` §1, «Deuda de despliegue».

## Cómo se verifica

```sh
pnpm typecheck && pnpm lint && pnpm test:unit     # gate por commit
pnpm test                                         # las 11 suites (matriz honesta)
node scripts/calidad.mjs                          # trinquete: tamaño, comentarios, fechas
pnpm arch:validate                                # Archify al día con el árbol
bash ops/scripts/validate.sh && node ops/tests/run-all.mjs
pnpm qa:layout                                    # maquetado 1080p
```

## Preguntas abiertas para el dueño

- **Retención de grabaciones de TUI.** Se escriben 0600 con tope por sesión y nadie las borra.
  ¿Cuánto tiempo, en qué volumen, quién poda?
- **Inventario.** `ws-isa-workspace` no está en `ops/flota.json`, así que la guardia de
  colisiones no ve el caso documentado de dos contenedores montando el mismo `.claude`. Añadir el
  contenedor al inventario es la única forma de que lo vea (D8: sin tablas a mano).
- **Métrica de colisiones.** `cauce_context_path_collisions` se escribe en
  `~/.local/state/cauce-v3/contexto-colisiones.prom` y hoy nadie lo raspa; la señal es el código
  de salida y el informe. ¿Se cablea un raspado de ficheros o basta la guardia?
- **Presupuesto de contexto de claude y hermes.** No hay un tope medido del que derivarlo; la
  entrada queda presente y sin tope hasta que se fije un número.
- **Recarga por el propio alias.** El endpoint sin tenant deja que un alias re-materialice su
  propio contexto con su certificado. ¿Se acepta, o la recarga es sólo de operador?
- **Cuerpo del manual en el diario.** Hoy se guarda sha y bytes; guardar el cuerpo permitiría un
  diff real del manual a cambio de retención.
- **Kill switch del modo escribible.** Arranca apagado por variable; ¿se prefiere que el grant
  baste?
- **`ultimate-terminal`.** Apagar el worker legado contenedor a contenedor y renombrar el permiso
  con ventana de convivencia son decisiones fuera del árbol.
- **Raspado del relay.** `6cecfb33` añadió Prometheus a `[backend, edge]` para que el job
  `cauce-relay` resuelva `terminal-relay`; ese commit ya está en línea con la fila `00358416` y lo
  que falta es verificar el raspado por efecto (el job `cauce-relay` en `up` dentro de `/targets`).
  Nada en el árbol fija esa pertenencia —no hay test sobre `deploy/compose.yaml`—, así que
  revertirla no pondría rojo nada y el raspado volvería a faltar en silencio. El cambio deja además a los
  tres frontales de `edge` con acceso de lectura a la API de consulta de Prometheus.
- **Auditoría `secret.granted` sin tope** y `pruneSettledHandoffs` sólo en `POST /v3/secrets`:
  anotado en las reseñas del plano de secretos; no cambia el comportamiento pero conviene decidir
  la poda.
- **Sesión de consola sin atribución.** Sigue pudiendo abrir una shell (sí) y leer gobierno (sí);
  ya no puede escribir gobierno ni tomar el teclado. ¿Se quiere cerrar también la shell?
