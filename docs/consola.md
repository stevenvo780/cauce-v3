# Consola web del operador

SPA React 19 + Vite destinada al operador del sistema. Se sirve en el mismo origen y consume exclusivamente las rutas `/v3/console/*` y `/v3/status` del gateway — no es un consumidor de entregas y no almacena estado duradero. La sesión se gestiona mediante la cookie `__Host-cauce_session`, emitida externamente; el navegador no guarda tokens ni identidad.

Véase [arquitectura.md](arquitectura.md) para el contexto general del sistema.

## Enrutamiento

No utiliza `react-router`. El enrutamiento (`matchRoute`, `ROUTE_TABLE`, `ROUTE_ALIASES`) vive en `src/App.tsx`; `src/router.ts` aporta sólo la navegación (`navigate`, `redirect`, `onNavClick`) que `App.tsx` consume, no el enrutamiento en sí.

## Vistas

| Directorio | Función |
|---|---|
| `features/landing/` | Dashboard: estado rápido del sistema |
| `features/live/` | Estado de flota en tiempo real y drawer de agente: una única vista `Contexto` para editar perfil y manual, más `Ficheros` como visor |
| `features/messages/` | Conversaciones y única superficie de publicación durable |
| `features/deliveries/` | Política canónica de estados y ejecución segura de comandos sobre entregas |
| `features/queues/` | Colas de salida, DLQ y única superficie de replay/cancelación/resolución |
| `features/observability/` | Métricas, gráficos, salud de colas |
| `features/config/` | Configuración versionada con OCC |
| `features/accounts/` | Gestión y selección de cuentas/tenants |
| `features/auth/` | Login OIDC / contraseña / selección de sesión |
| `features/audit/` | Visor de eventos de auditoría y telemetría |
| `features/terminal/` | Terminal interactiva vía xterm.js (ver abajo) |
| `features/help/` | Ayuda integrada en `/ayuda`: qué contesta cada vista, qué significa cada estado de la flota y los atajos; el índice se deriva de `NAV_ENTRIES`, así que no puede describir una vista que no existe |

## Armazón de página

Ninguna vista inventa su propio contenedor: el ancho, la cabecera y el scroll salen de dos
primitivas de `components/ui.tsx`.

- `PageHeader` es la cabecera única — antetítulo, `h1`, acciones a la derecha y el texto
  explicativo dentro de `PageHelp`, nunca como párrafo suelto. Ocupa el ancho del contenido, no la
  medida de lectura, y queda pegada arriba y opaca sobre `--bg` para que el título de la vista siga
  legible mientras una tabla de tres pantallas hace scroll. Por debajo de 640 px pasa a una sola
  columna, donde la acción ya no cabe junto al título.
- `PageShell kind` declara qué clase de página es el cuerpo:
  - `documento` — se lee línea a línea y se limita a `--measure-prose`: `/config` y `/ayuda`;
  - `aplicacion` — ocupa una altura de ventana y gestiona su propio scroll: `/terminal`.

`aplicacion` no lleva alturas mágicas: la vista mide en runtime lo que ocupa lo que tiene encima y
lo escribe en `--shell-tope`. `/messages` resuelve lo mismo con su propia medida `--messenger-tope`.

## Tema de la consola

`components/ThemeControl.tsx` vive en la barra superior y ofrece tres estados: **sistema**,
**claro** y **oscuro**. `claro` y `oscuro` estampan `data-theme="light"` o `data-theme="dark"` en
`<html>`; `sistema` **retira** el atributo y devuelve la decisión a `prefers-color-scheme`.

La paleta se declara por tres caminos en `styles/base.css`: la clara en el `:root` desnudo —ningún
color tiene su única definición dentro de una media query— y la oscura dos veces con los mismos
valores, una para la preferencia del sistema (`:root:not([data-theme="light"])`) y otra para el
atributo forzado (`:root[data-theme="dark"]`). `styles.legibilidad-themes.test.ts` lee los tres
caminos y exige en todos el mismo juego de tokens y contraste AA.

La elección se recuerda en `localStorage` bajo la clave `cauce.tema`, y cada lectura y cada
escritura van en `try/catch`: una ventana privada lanza en todo acceso al almacenamiento y el tema
no puede ser el motivo de que la consola no pinte. Es la **única excepción** del validador
`ops/scripts/validate-console-browser-storage.mjs`, acotada a `ThemeControl.tsx` —y a su test—, al
arranque `public/tema.js` y a esa clave. Lo que la prohibición protege es otra cosa: identidad,
semántica de mensaje y material de idempotencia duraderos en el navegador. El nombre de un tema no
es ninguna de las tres.

El tema forzado tiene que estar en `<html>` **antes del primer pintado**, o el operador ve un
destello del tema contrario. Eso lo hace `public/tema.js`, que `index.html` carga con
`<script src="/tema.js"></script>` delante del paquete: es un **fichero del mismo origen y no un
bloque en línea** porque la consola sirve `script-src 'self'`, que jamás ejecuta script inline —un
`<script>` incrustado no correría en producción y además dispararía una violación de CSP en cada
carga. Marca también el `<meta name="theme-color">` que toca, para que la barra del navegador
acompañe al tema forzado. La clave y los tres nombres están repetidos ahí porque el arranque no
pasa por el bundle; `src/tema-bootstrap.test.ts` importa `CLAVE_TEMA` y `TEMAS` de
`ThemeControl.tsx`, lee `public/tema.js` y se pone rojo si las dos copias divergen.

## Pliegue: qué se ve sin hacer scroll

Cada vista declara su **objeto principal** con `data-objeto-principal` —la tabla de flota en
`/live`, el hilo en `/messages`, la caja de terminal en `/terminal`— y el criterio de v3.1 es que
ese objeto empiece por encima del pliegue. El gate de maquetado lo mide (más abajo); en `/live` la
maquetación que lo persigue es una sola tira de mando —refresco, triaje y veredicto— pegada arriba a
partir de 1101px, más la leyenda y el mapa de la flota dentro de `<details>` que arrancan plegados,
porque el mapa abierto deja la tabla fuera del primer pliegue. Por debajo de 1101px nada de `/live`
se pega y la cabecera global vuelve a ser lo que mantiene el título alcanzable, como en el resto de
las vistas.

## Autoridades únicas de escritura

Cada entidad operativa tiene una sola superficie de mutación. Las demás vistas pueden proyectar el
mismo dato para dar contexto, pero sólo enlazan a su autoridad:

- `/live`, pestaña **Contexto**: perfil canónico y manual del arnés del agente;
- `/accounts`: cuentas de proveedor, techos por alias y bindings de fallback;
- `/messages/:tenant/:alias`: redacción y publicación durable;
- `/queues?delivery=:id`: replay, cancelación y resolución de DLQ;
- `/config`: topología, registro de agentes, políticas y revisiones; no acepta contextos ni recursos
  del pool de cuentas;
- `/terminal/:tenant/:alias`: PTY, transcript y ACK en lectura. La ruta histórica
  `/fleet/:tenant/:alias` redirige a este detalle canónico.

La política de los ocho estados de entrega vive en `features/deliveries/delivery-policy.ts`; los
rótulos, tonos, filtros y acciones no mantienen listas paralelas. Los comandos operativos validan
el recibo exacto y releen la cola ante una respuesta incierta antes de afirmar éxito.

## Contexto y ficheros de gobernanza

El drawer de `/live` tiene un solo lugar de mutación: la pestaña **Contexto**. Allí conviven dos
controles distintos sin duplicar navegación:

- el perfil canónico (`purpose`, `role_summary`, `human_brief`, responsabilidades, restricciones,
  herramientas declaradas y reglas operativas), leído y escrito mediante
  `GET|PUT /v3/console/tenants/:t/agents/:a/perfil`;
- el texto manual ajeno al perfil, leído y escrito mediante
  `GET|PUT /v3/console/tenants/:t/agents/:a/documents/directive/content`.

Ambas escrituras ya tienen rutas en el gateway y requieren hechos medidos del runtime, control de
acceso y ACK verificable. El perfil usa revisión esperada y se aplica como lote. El manual usa
`expected_sha` —o `create_if_absent` para un fichero realmente ausente— y rechaza el conflicto si
otro operador escribió primero.

Los bloques delimitados por los marcadores reservados `<!-- CAUCE:CONTEXTO-FIJO ... -->` /
`<!-- CAUCE:FIN-CONTEXTO-FIJO -->` y `<!-- CAUCE:PERFIL ... -->` /
`<!-- CAUCE:FIN-PERFIL -->`, junto con `<!-- CAUCE:REVISION-PERFIL ... -->`, pertenecen al perfil
canónico. El PUT manual conserva esos bloques y rechaza cualquier intento de modificarlos,
retirarlos o introducir nuevos marcadores `CAUCE`; el texto libre de fuera sigue siendo editable.
Así el editor manual no se convierte en una segunda vía para cambiar el perfil.
Si el fichero contiene un marcador `CAUCE` de una versión que el gateway todavía no conoce, la
edición falla cerrada hasta actualizarlo. En documentos CRLF, la consola restaura ese mismo estilo
de salto antes del PUT para no alterar los bloques por la normalización propia de `<textarea>`.

`Ficheros` no guarda nada: lista rutas derivadas de hechos medidos y abre únicamente contenido
permitido en modo de sólo lectura. Configuraciones sensibles, credenciales, directorios y memoria
viva permanecen fuera de la escritura web.

El campo `tools` del perfil sólo declara herramientas en el contexto. No concede permisos, no
habilita binarios ni configura MCP; las capacidades acreditadas proceden del runtime y la
autorización efectiva de membresías, `role_policies`, ACL y RBAC.

La aplicación canónica por lote existe para Claude, Codex y OpenClaw. Hermes sólo puede ofrecer el
manual que su runtime mida; no se presenta como compatible con ese lote. OpenCode no pertenece al
juego de arneses soportado y la consola no ofrece una edición ficticia para él.

### Qué enseña el cajón sobre el contexto

- **Ubicación medida frente a declarada.** El pie de la directiva ya no presenta
  `agents.container_name` ni `agents.home_directory` como la ubicación del alias: son columnas
  declaradas y `docs/directiva-ficheros-del-agente.md` §3 documenta las dos como mentirosas
  (para `iza` dicen `ws-humanizar` y `/home/dev` cuando corre en `claw-iza` con `HOME=/home/claw`).
  El `$HOME` y el arnés salen de la medición del contenedor, y sólo cuando el mapa de ficheros
  llega con `facts_source: measured`; con `registry` o `database` las rutas están deducidas de esas
  mismas columnas y no cuentan como medición. Cuando lo declarado y lo medido difieren se muestran
  los dos, «declarado X · medido Y», porque esa discrepancia es justo el diagnóstico que hace falta
  para no editar el fichero equivocado. Si no hay hecho medido dice «desconocido» con esa palabra y
  no rellena con un valor plausible: `/home/dev` encaja en casi todos los alias y por eso engaña
  precisamente en el que rompe la regla. Ninguna ruta publica el nombre medido del contenedor (la
  directiva trae un identificador hexadecimal de Docker, que no sirve para contrastarlo con un
  `ws-humanizar`), así que se muestra rotulado como declarado y con la medición desconocida. El mapa
  de ficheros sólo se pide al desplegar el pliegue: abrir el modal no dispara esa lectura ni deja
  filas de auditoría de denegación.
- **Recargar contexto.** Cuando el perfil queda en `pending_session_refresh` o `drifted`, el aviso
  deja de ser sólo texto: ofrece «Recargar contexto», que reescribe y vuelve a medir los ficheros y
  presenta el resultado tipado (estado, evidencia y, por documento, sha antes y después). No
  reinicia la TUI, y si hay entregas en vuelo la confirmación las nombra.
- **Aviso de contaminación.** Si el veredicto llega contaminado —dos alias compartiendo fichero—
  el cajón lo pinta destacado con el motivo y el alias dueño del bloque ajeno, y deja el guardado y
  la recarga deshabilitados mientras dura la cuarentena, en vez de dejar que el operador lo
  descubra por un 409.
- **Historial y diff.** Un panel único sobre `agent_profile_revisions` y
  `agent_document_revisions` lista revisiones con actor y fecha, compara dos revisiones del perfil
  (los siete campos) y del manual (sha y bytes; el cuerpo del manual no se guarda) y restaura por
  la vía canónica: borrador en Contexto y PUT con CAS y ACK, nunca una escritura paralela.
- **`written_pending_session`.** El PUT del manual responde escrito en disco, no leído por el
  proceso. El editor del manual pinta ese estado con el mismo vocabulario que el perfil usa para
  `pending_session_refresh`, sin inventar uno paralelo.
- **La hoja de ruta no viaja en el bundle.** El pliegue «Lo que todavía no se puede desde aquí»
  nombra los dos huecos —herramientas y prompts— y remite a `docs/roadmap.md`, sección «Capas
  pendientes del contexto», en lugar de llevar su prosa dentro de la SPA.

## Cliente API

`src/api/client.ts` — cliente HTTP tipado con control de timeout y soporte de cancelación. El contexto se provee mediante `src/api/context.tsx` y el hook `src/api/use-resource.ts`.

El shell mantiene una sola lectura compartida de `/v3/console/access` mediante
`src/api/console-access.ts`; navegación y vistas consumen el mismo `Resource` y no consultan los
permisos por separado. Del mismo modo, `features/terminal/relay-status.ts` es la única autoridad de
la capacidad del relay para la navegación y la Terminal. Los `Boundary` de ambos módulos existen
únicamente para montar componentes de forma aislada en tests.

## Terminal interactiva

`src/features/terminal/pty-session.ts` gestiona la sesión WebSocket en el mismo origen, que el gateway proxea hacia `terminal-relay`. Véase [terminal-pty.md](terminal-pty.md) y [services/terminal-relay/README.md](../services/terminal-relay/README.md).

La página es una vista de `aplicacion`: la caja de terminal no tiene altura fija ni techo, se estira
hasta el alto de la ventana menos `--terminal-tope` —con un suelo de 430 px para que nunca quede
inservible— y ese tope sale de medir en runtime lo que hay encima, no de una constante escrita a
mano. La columna de flota se pliega a una tira de iconos con un
botón nombrado que declara `aria-pressed` y `aria-controls` —no `aria-expanded`: plegada la lista
sigue renderizada y enfocable, y decir que está colapsada sería mentirle al lector de pantalla.

### Tomar y devolver el teclado de una TUI

Sobre una TUI de sólo lectura (`harness`) la consola sólo mira. Para **teclear** hace falta el modo
`harness_rw`, y `src/features/terminal/ControlDeTui.tsx` es todo el flujo:

- **El botón existe sólo si el gateway dice que se puede.** La condición es `writable_modes` de
  `/targets`, nunca que `harness_rw` aparezca en la lista de modos: la consola no deduce qué es
  escribible a partir de un nombre.
- **El motivo lo escribe la persona**, entre 8 y 280 caracteres, sin plantilla y sin texto
  generado. La frase que la consola sí redacta sola —la que justifica una observación de sólo
  lectura— no llega nunca a esta escritura. Ese motivo es lo único que queda en la fila de
  auditoría de la toma.
- **La consecuencia está en pantalla antes de escribir nada:** mientras alguien tiene el control,
  el bus **no le entrega mensajes a ese alias**; quedan en cola y salen en orden al devolverlo.
- **La toma se envía cuando la sesión escribible ya está atada por el relay**, no al pedirla: un
  arriendo sobre una sesión que todavía no se consumió no tendría a quién callar.
- **Devolver siempre está a mano** y sobrevive a un error. También se dispara solo al desmontar el
  panel y en `beforeunload`: un arriendo que sobrevive a la pestaña es lo que deja a un agente
  callado. Si el relay cierra con `4410` el control ya no es tuyo, y la consola lo dice en
  castellano en vez de fingir una devolución que no ocurrió.

El porqué de cada una de esas reglas está en
[ADR-009](adr/009-control-de-tui-desde-la-consola.md), y el runbook operativo —compuertas,
interruptores, arriendo y grabación— en el §4 de [terminal-pty.md](terminal-pty.md).

## Gate de regresión visual

`qa/layout-gate.mjs` (ejecutar con `pnpm qa:layout`): lanza la consola con mocks y recorre con
Chromium las diez rutas declaradas en `ROUTES` —`/`, `/live`, `/accounts`, `/messages`, el hilo
`/messages/<tenant>/<alias>`, `/queues`, `/observability`, `/config`, `/terminal` y `/ayuda`— más
los dos estados del cajón de `/live`, a 360/760/1100/1440/1920/2560 px sobre una ventana de 1000 px
de alto. El hilo se mide aparte porque en `/messages` a secas no hay conversación abierta y el
objeto principal de esa vista sólo existe con una.

Mide el desperdicio horizontal (ancho útil, hueco lateral, desborde, recorte con y sin alcance de
teclado), la accesibilidad de la nav (enlaces sin nombre, rótulos solapados, portadores pequeños) y
el desperdicio vertical: `foldDesaprovechado` —la banda muerta bajo lo último realmente pintado
dentro de `main`, no bajo la caja que un `<details>` plegado sigue reportando—, `objetoPrincipalTop`
y `objetoPrincipalBajoElPliegue`, más las `pantallas` de scroll de cada ruta. Línea base en
`qa/layout-baseline.json`. La semántica del trinquete, los objetivos de v3.1 y la única forma
sancionada de subir un valor registrado están en
[calidad-y-gates.md](calidad-y-gates.md#gate-de-maquetado-pnpm-qalayout). Requiere
`npx playwright install chromium`.

## Despliegue

Dockerfile genera una SPA estática servida por nginx-unprivileged. TLS con certificado propio, mTLS hacia el gateway. El contenedor se ejecuta sin root y con filesystem de solo lectura.

## Tests

La consola mantiene tests Vitest + jsdom, sin fijar en esta guía un conteo que envejece con cada
regresión nueva:

```bash
pnpm --filter @cauce/console test
```

## Restricciones clave

- La consola **no importa** paquetes `@cauce/*` — está desacoplada en la frontera HTTP.
- Sin almacenamiento de tokens ni identidad en el navegador:
  `ops/scripts/validate-console-browser-storage.mjs` prohíbe `localStorage`, `sessionStorage`,
  IndexedDB, `caches` y `document.cookie` en `console/src` y en `public/tema.js`, con la única
  excepción de la clave `cauce.tema` del control de tema.
- CSP estricta: `script-src 'self'`, `style-src 'self'`; únicamente `style-src-attr 'unsafe-inline'` para la geometría de xterm.
