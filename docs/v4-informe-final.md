# Informe final de Cauce V4

**Estado: V4 no está terminada.** Esqueleto para el orquestador. Los criterios 8 y 9 de [`GOAL.md`](../GOAL.md) §12 piden este informe; quien cierra la tarea lo completa con la evidencia final de producción. Aquí solo entra lo que hoy dicen `GOAL.md`, los informes de la tanda y `git log`.

`GOAL.md` §12 abre así: la V4 solo puede darse por terminada cuando los criterios 1 a 9 se cumplan y se verifiquen, y ninguno está cumplido entero todavía. Las casillas de los apartados 5 y 7 están marcadas en ese documento. El párrafo inicial sigue diciendo que ninguno está cumplido entero. Este esqueleto no sube ninguna casilla abierta.

Tres niveles, los mismos de `GOAL.md`:

- **Implementado** (`[código]`): el cambio está en el árbol, con la prueba focal que lo acompaña.
- **Probado en local** (`[local real]`): se ejecutó con PostgreSQL, Docker, Git o Chromium reales. No es el despliegue.
- **Verificado en el despliegue** (`[desplegado]` o `[prod]`): comprobado en el entorno publicado.

La publicación que este checkout puede leer está en [`deploy/HISTORIAL.md`](../deploy/HISTORIAL.md). El procedimiento de actualización está en [Desplegar V4](operacion.md#desplegar-v4). Este archivo no copia digestos, direcciones ni rutas de ese historial.

## Versión que este esqueleto puede citar

| Dato | Valor |
|---|---|
| Última fila de `deploy/HISTORIAL.md` | `20261025T072919Z`, commit `666fe368`, smoke OK, con recibo de gates |
| Título de ese commit | `chore(release): regenera digests operativos y conteos de pruebas del candidato V4` |
| Registro de esa fila | `f73e17da` — `docs(deploy): registra el despliegue 666fe368` |
| Release anterior citada por el criterio 3 | `892b0c3f`, fila `20261025T062703Z`, el mismo título de release, smoke OK |
| Alta de harness citada por el criterio 5 | `0ab397e1`, fila `20261018T051522Z`, el mismo título de release, smoke OK |

`666fe368` es la última fila escrita en el historial en el momento de este esqueleto. No es, por sí sola, la versión final integrada que pide el criterio 8: el criterio padre sigue abierto. Los agentes medidos el 25-oct sobre `892b0c3f` no quedan trasladados a `666fe368` por el hecho de que exista una fila posterior.

PENDIENTE: confirmar en el sistema vivo que `666fe368` sigue siendo lo publicado, o sustituir esta fila por la que corresponda al candidato final. Escribir entonces el commit desplegado, los entornos comprobados, el esquema efectivo y la ubicación final de cada agente migrado. Recorrer en ese despliegue los flujos esenciales y pegar el resultado.

## 1. Multiempresa operativa y aislada

Se exige que Humanizar y Praxis funcionen con sus recursos reales, que un usuario nuevo pueda registrarse, crear su empresa y usarla, y que las pruebas impidan leer datos o ejecutar operaciones de otra empresa, también con solicitudes manipuladas fuera de la interfaz.

La casilla padre sigue abierta en `GOAL.md`. Dentro, estas cláusulas están marcadas:

- `[local real]` 24-oct: un usuario nuevo se registra (respuesta 201), crea su empresa y entra como owner. Usa la empresa (sala, agente, membresía, persona, invitación de ordenador y cuenta de cuota). Cuarenta ataques manuales de acceso cruzado (identificadores, `company_id` y `tenant_id` en ruta, query, cabeceras y cuerpo, blobs, mensajes, sin cookie, sin CSRF y con `Origin` ajeno) no devuelven datos ajenos. `verify:external` da 294 casos y 0 fallos. 27 casos quedan `not_mounted` porque la terminal y el relay no se montan en ese local.
- `[local real]` Aislamiento por familias de rutas y en la base.
- 24-oct `[prod]`: Praxis con sus tres agentes en `<host-local>`, respondiendo a León. Cauce retirado de `<hospital>`. Humanizar con su flota en `<vps>` y en `<host-local>`.
- `[prod]` Registro usable: alta atómica de empresa por la web y limitador por IP real tras el proxy. Ocho empresas de prueba creadas por la comprobación del 17-oct.
- `[local real]` La guardia enumera las rutas `/v3` sin excepciones. Commit `0583c45b` — `test(aislamiento): la guardia entre empresas queda sin known_leak, con regresiones de hosts y cuotas y la ruta /v3/context/ingest cubierta`. 294 casos y 0 fallos. La frase «probadas contra el despliegue» fue retirada el 17-oct.

Sigue abierto el criterio padre. La comprobación de solicitudes manipuladas contra el despliegue no está acreditada.

PENDIENTE: repetir el aislamiento contra el candidato final publicado y anotar el resultado sin datos de clientes.

## 2. CRUD completo y real

Se exige haber probado creación, consulta, edición y eliminación de todas las entidades administrables, desde la interfaz y en sus efectos persistentes y remotos, sin botones ficticios, operaciones incompletas ni recursos huérfanos.

La casilla padre sigue abierta. Dentro, estas cláusulas están marcadas:

- `[local real]` CRUD con persistencia de empresas, clientes, salas, membresías, registro de agente, cuentas, plano e invitaciones.
- `[local real]` Executor contra Docker real local.
- 18-oct `[prod]`: agentes, ordenadores, personas, entornos de cuota y contextos con ciclo real y efectos remotos en los dos ordenadores de esa comprobación. Agentes: crear, preparar, reanudar o cancelar, detener, retirar y purgar. Ordenadores: enrolar, permisos y baja con copias. Personas. Entornos de cuota: crear y eliminar con contenedor y volumen. Contextos: 14 agentes sembrados y sincronizados con GitHub, y edición desde la consola. Lo único que esa comprobación deja sin probar es arrancar un agente autenticado con una cuenta real, porque depende del login del dueño.
- 21-oct: la purga borra el contenedor y el volumen `-provider-profiles` (`ops/cli/fleet_executor_container.py`). Los campos inertes se declaran en `console/src/features/config/campos-inertes.ts`.

Sigue abierto el criterio padre. Arrancar un agente autenticado con una cuenta real no está probado.

PENDIENTE: el ciclo de autenticación real del dueño sobre un agente del candidato final, y el cierre de las filas rojas de la tabla de funciones (ciclo de flota, cancelación de actualización, alta de persona desde la oficina, salas desde la oficina y la consola ancha, inicio de sesión del proveedor).

## 3. Gestión distribuida funcional

Se exige registrar ordenadores e instanciar, administrar y eliminar espacios y agentes en ellos. Gaia, Hegel, Hades y Argos deben funcionar en servidores locales, conservar su información, y la liberación de recursos en `<vps>` debe estar medida. El CLI `cauce` y las terminales remotas deben mantener sus capacidades.

La casilla padre sigue abierta. Marcado:

- `[local real]` Enrolamiento con identidad firmada y relocalización entre hosts, con PostgreSQL.
- `[local real]` El CLI conserva su despacho previo.
- 21-oct `[prod]`: `<host-local>` (Humanizar y Praxis) ejecuta Gaia, Hades, Hegel, Teseo, Perseo y el Operador sin intervención del administrador.

Sigue abierto, con el texto de `GOAL.md`:

- Gaia, Hegel, Hades y Argos, y los agentes de Praxis, en servidores locales con su información, y la liberación medida. El 25-oct `[prod]` se midió con `ops/scripts/v4-medicion-migracion.sh comparar`, con el mismo alcance que la foto del 18-oct. En `<vps>`, Argos libera 9,5 GB de disco propio y 1,8 GB de RSS; Gaia, 0,9 GB y 0,3 GB; Hades, 2,4 GB y 0,2 GB; Hegel, 0,13 GB de RSS. Ya no existen los contenedores `agv2-*` de Gaia y Hades. La memoria total de `<vps>` no baja (+5,6 GB), porque desde el 18-oct crecieron otros servicios. Falta Hades, atascado en una cancelación entre releases. Las terminales de Argos y Hegel ya corren en `<host-local>` (25-oct, 00:50).
- Terminal por CLI para la flota dinámica.
- `[prod]` Adaptadores V3 en la release vigente, sin tocar terminales ni credenciales. El 25-oct: Kant (nativo, `<host-local>`) en la release de `892b0c3f` con entrega real verificada. Salva (contenedor, `<host-local>`) y Zeus (contenedor, `<vps>`) quedaron con proceso en la release nueva y lease fresco tras el arranque. La entrega de prueba no se pudo acreditar: la sala de Salva pertenece a otra persona (la consola rechaza al operador con `invalid_actor`, aislamiento correcto) y el login de Claude de Zeus está caducado. La herramienta tenía tres defectos que dejaban caído un agente en contenedor: modos del bundle distintos de la copia al contenedor, nombre de release no ligado al contenido, y sonda sin esperar al arranque. Esos tres quedaron corregidos, y Salva se devolvió a su release anterior mientras tanto. Falta el caso astra (`KillMode`), comprobar que un error inmediato de la API ya no espera 5 minutos, y el relogin de Zeus.

`96117c2c` — `fix(cli): resolver el terminal desde el runtime instalado` — y `129b1c78` — `refactor(cli): reutilizar el aprovisionamiento del canal PTY` — están en el árbol. No cierran la casilla de la terminal por CLI para la flota dinámica: `GOAL.md` la deja abierta y no hay dos corridas de producción de ese recorrido.

PENDIENTE: la ubicación final de Gaia, Hegel, Hades, Argos y de los agentes de Praxis sobre el commit publicado del cierre; la salida de Hades de la cancelación; la terminal CLI de la flota dinámica en el despliegue; la entrega de prueba de Salva y de Zeus; astra; la espera de 5 minutos; el relogin de Zeus.

## 4. Cuotas reales desde la web

Se exige que funcionen las cuotas por agente y «Mis cuotas»: autenticación, consulta, actualización de CLI y administración de entornos. Varios agentes pueden compartir una cuenta sin errores ni saldos independientes. Las ventanas y los estados mostrados corresponden a los datos reales disponibles.

La casilla padre sigue abierta. Marcado:

- `[local real]` «Mis cuotas»: cuentas sin agente y tarjetas fijadas, con persistencia.
- `[local real]` Estados explícitos y cuenta compartida modelada sin saldos independientes.
- El dueño crea, autentica, consulta, actualiza y elimina un entorno de cuotas real desde «Mis cuotas». En la fecha de esa nota había 0 entornos en producción. Depende de un ordenador con ejecutor.

Sigue abierto: cuotas por agente según harness; una cuenta compartida por dos agentes reales; ventanas contrastadas; verificado en producción. El 18-oct `[prod]`, la barra y las cuentas de la ficha de los 14 agentes coinciden con el CLI `cuotas` a 0 puntos, con reinicios iguales. Tres cuentas compartidas muestran el mismo saldo en todos sus agentes. Falta el lector «según harness» dentro del contenedor: dice «Todavía no hay una medición persistida» en los 14 (8 sin ubicación V4), y se cierra con los traslados.

En laboratorio, el mapa de vistas deja en verde el alta, el pin y la baja de cuenta (`v4-cuotas-agent-real-browser`) y el entorno (`v4-quota-environments-real-browser`: 7/7 en 145,54 s y 7/7 en 89,75 s, las dos con salida 0). La fecha civil de ese par no está en el mapa.

PENDIENTE: fecha de esas dos corridas; el lector dentro del contenedor sobre agentes con ubicación V4; una cuenta compartida por dos agentes reales en el despliegue; las ventanas contrastadas con el dato disponible.

## 5. Oficina y harnesses operativos

Se exige que la oficina responda a la creación, edición, asignación y eliminación de salas y agentes, que su configuración persista, que el detalle de cada agente muestre cuotas y estado visual, y que la configuración de harnesses se haya probado con operaciones reales sin cambios dispersos por integración.

La casilla padre está marcada en `GOAL.md`. El párrafo inicial de §12 dice que ninguno de los nueve está cumplido entero. Este esqueleto no declara el criterio cerrado.

Marcado dentro:

- `[local real]` El plano persiste tras recargar y en otro navegador.
- `[código]` Salas y agentes dinámicos, y cansancio con estados distintos.
- `[prod]` La oficina refleja altas y bajas, el campus sigue el plano y la ficha abre con datos reales. Comprobación en producción del 18-oct, sin bloqueos.
- Harnesses con operaciones reales y alta sin cambios dispersos. 18-oct `[prod]`: alta de un harness en 3 archivos (descriptor, bin y entrada de `package.json`; antes eran 10), desplegada en `0ab397e1`. Plantillas reales Claude, Codex, Grok, Muse y OpenClaw (Claude, Grok y Codex) medidas en la imagen firmada y anunciadas por `<host-local>` (7 plantillas). Los canarios llegan a `awaiting_auth` en los dos ordenadores de esa comprobación.

El mapa de vistas deja el campus en verde con `v4-oficina-campus-real-browser`. El guardado del plano queda en verde en `v4-crud-matriz-real-browser` (9/9 en 80,96 s y 9/9 en 73,70 s). Las suites `v4-office-real-browser` y `v4-console-real-browser` siguen en rojo en ese mapa. La fecha civil de los pares verdes no está escrita.

PENDIENTE: fecha de esas corridas, y decidir si el rojo de la oficina y de la consola ancha impide dar por cerrado el criterio pese a la casilla marcada. El orquestador no hereda de este esqueleto un cierre.

## 6. Archivos ordenados y contextos versionados

Se exige que los espacios usen la estructura estándar sin pérdida de datos ni rutas rotas; que el repositorio compartido de GitHub contenga las carpetas de los agentes y registre sus cambios; y que estén probadas la edición por las vías soportadas, el historial, las diferencias, la restauración, la aplicación efectiva al agente, las escrituras concurrentes y la recuperación tras un fallo de sincronización, sin exponer secretos ni contextos entre empresas.

La casilla padre sigue abierta. Marcado:

- `[local real]` Concurrencia con CAS sin descartar contenido. Guardado, Git y sincronización separados, con fallo recuperable. Historial, diff y restauración. Identidad estable y aislamiento en el repositorio.

Sigue abierto: espacios reales con la estructura estándar; repositorio con las carpetas reales; edición por todas las vías; aplicación con turno real; recuperación ensayada en producción. El 25-oct `[prod, solo lectura]`: el repositorio de contextos del gateway tiene la carpeta de los 17 agentes reales de las dos empresas, el último commit igual a la última versión en la base, y el outbox `synced` (23/23). Solo cuatro agentes de prueba o huérfanos no tienen ninguna versión: `zz-prueba-codex`, `canario2`, `canario3` y `operador-muse`.

`[local real]` Alta, edición en consola y edición por CLI con autor humano en un remoto Git de laboratorio, dos veces en verde. Commit `7d2f38d3` — `test(e2e): verify agent creation and console/CLI context commits`. El informe de esa corrida no fija la fecha civil.

OpenClaw acredita la adopción con turnos reales en el laboratorio. Commit `c185cf53` — `fix(context): accredit OpenClaw context adoption and converge seeded profiles`. Pendiente de desplegar. Faltan Muse, la revisión N+1 de extremo a extremo, la concurrencia y la recuperación en producción. Esas dos últimas siguen en curso.

El inventario de solo lectura de la misma tanda añade, sin cerrar la casilla: los siete agentes del runtime V4 tienen las siete carpetas estándar; diez runtimes anteriores no tienen el directorio `space`; ningún agente tiene `applied_version` distinto de 0; las filas de copia de Gaia que se vieron estaban en `failed` / `EXPORT_FAILED`. Otro informe de la tanda dice que producción seguirá en `applied_version` 0 hasta que se despliegue la cadena de contexto y los agentes tomen turnos.

El temporal del turno de contenedor queda en `space/tmp`. Commit `5a9e8d31` — `fix(ops): el temporal del turno queda en space/tmp`. Dos corridas de laboratorio posteriores, salida 0, 3/3 cada una, a las 06:56:04 y a las 06:56:13 (duración 4,49 s y 4,93 s). La fecha civil no está en el informe. No está desplegado: Operador, Perseo, Teseo, Gaia, Hegel y Argos toman ese `TMPDIR` cuando vuelvan a arrancar.

El mapa de vistas dejó en rojo confirmar la restauración, aplicar al agente y el editor de ficheros (`v4-contexts-real-browser`, `v4-context-files-real-browser`, y también `v4-contexto-repositorio`) por un `GET` de copias que respondía 404. Un informe posterior de la misma tanda, `bfdcf15f` — `test(e2e): configure real backups in context browser fixtures`, registra esas tres suites en verde dos veces, en laboratorio. No es producción. La fecha civil no está en el informe.

La continuidad entre dos humanos quedó en verde dos veces en laboratorio. Commits `7c40ba55` — `test(e2e): select continuity witness turns by content` — y `29752c82` — `test(e2e): own the cross-machine lab precondition`. La precondición entre máquinas que el mapa anotaba como hueco de la prueba quedó en manos del laboratorio de la suite, también dos veces en verde. Fecha civil: PENDIENTE.

PENDIENTE: desplegar la cadena de contexto; acreditar Muse y el turno N+1; ensayar concurrencia y recuperación en producción; fecha de los pares de laboratorio; rearranque que aplique `TMPDIR` en los seis alias; primera versión de los cuatro alias sin ninguna.

## 7. Copias, recuperación y diagnóstico comprobados

Se exige poder descargar una copia del contenido de un espacio y restaurarla en un entorno de prueba, que los fallos relevantes dejen un rastro útil, y que podar auditoría no haya roto funciones ni quitado controles necesarios.

La casilla padre está marcada en `GOAL.md`. El párrafo inicial de §12 dice que ninguno de los nueve está cumplido entero. Este esqueleto no declara el criterio cerrado.

Marcado dentro:

- `[local real]` Restauración en un entorno de prueba con datos sintéticos.
- El dueño descarga desde la consola la copia de un espacio real y la restaura siguiendo [el runbook de copias](v4-runbook-copias.md). 18-oct `[prod]`: dos copias pedidas desde «Perfil y contexto → Backup del espacio», ZIP descargado, SHA-256 igual al recibo y a la pantalla, restauradas y comparadas archivo a archivo. El historial Git ya no puede colar secretos.
- `[local real]` Rastro útil de fallos y poda de auditoría sin romper nada.

El mapa de vistas deja crear, descargar y eliminar la copia en verde: `v4-space-backups-real-browser`, 4/4 en 202,37 s y 4/4 en 192,45 s. Fecha civil: PENDIENTE.

El runbook deja escrito un límite que este esqueleto no suaviza: recuperar dentro de un agente con una identidad distinta se detiene, porque la herramienta rechaza el destino, y el repositorio aún no acredita un ciclo físico completo de reversión en un host real. El ensayo local demuestra backup y restauración de archivos. No demuestra arranque, autenticación, conmutación ni regreso de un agente desplegado.

PENDIENTE: fecha del par de `v4-space-backups-real-browser`; la evidencia de producción del candidato final, si el orquestador quiere sostener la casilla sobre una release posterior al 18-oct; el ciclo físico de reversión en un host real, si se decide que forma parte del cierre.

## 8. Pruebas reales en local y en el despliegue

Se exige haber ejecutado las pruebas correspondientes sobre la versión final integrada y haber recorrido los flujos esenciales en el entorno desplegado. Compilar, pasar el linter, usar mocks o responder un endpoint de salud no basta. Los errores encontrados se corrigen y los flujos afectados se vuelven a probar.

La casilla padre sigue abierta. `GOAL.md` lo dice así: esto no es la versión final integrada. Marcado dentro:

- `[prod]` typecheck, lint y empaquetado en verde sobre cada SHA publicado, con su recibo. La última fila que este esqueleto ve (`666fe368`, `20261025T072919Z`) dice smoke OK y recibo de gates. No se copia el digest.
- `[prod]` Flujos esenciales recorridos en producción, con el ciclo corregir y volver a probar: registro, personas, cuotas, ordenadores, mensajes, oficina, Ajustes botón por botón, móvil, aislamiento y primer día de un cliente (17–18 oct).

El mapa de vistas de la consola leyó la punta `03cbf7fa` y cruzó las escrituras con un barrido de dos corridas por suite. Totales de escrituras en ese mapa: 40 verdes, 7 rojas, 0 no corridas, 3 sin E2E, 1 suite nueva, 51 filas. La fecha civil del barrido no está en el mapa. La suite nueva, `v4-appearance-nudge-real-browser`, commit `2b982003` — `test(e2e): persistir el tono fino del icono en escritorio y móvil`, salió 0 dos veces en laboratorio (2/2 en 28,85 s y 2/2 en 28,10 s). Fecha civil: PENDIENTE.

Este esqueleto no ejecutó el gate ni el barrido. Esos resultados no son una corrida propia.

PENDIENTE: dos corridas en verde del candidato final integrado, con fecha, y el recorrido de los flujos esenciales en el despliegue de ese candidato. Los recibos de gate de los SHA ya publicados no sustituyen ese recorrido.

## 9. Despliegue final y documentación completos

Se exige que los cambios estén integrados y desplegados, que la versión publicada corresponda al código verificado, que la documentación describa todas las funciones reales y los procedimientos de operación y recuperación, y que no queden pendientes críticos detrás de un «se hará después».

La casilla padre sigue abierta. Marcado dentro:

- `[desplegado]` Integrado en `dev` y `main`, desplegado, versión publicada igual al código verificado. La fila vigente de este esqueleto es la de la sección «Versión». Lo integrado en la rama después de `666fe368` no queda desplegado por estar en el árbol.
- `[prod]` Guía y operación V4 al día ([`docs/v4-guia.md`](v4-guia.md), [`docs/operacion.md`](operacion.md)), seguidas al pie de la letra contra producción y corregidas (18-oct).

Después de esa corrección, el árbol tiene `a3054545` — `docs(v4): describe las funciones y la recuperación reales` — y `fc9b3b04` — `fix(console): los avisos nombran la pestaña Ejecución`. La pestaña visible del agente es Ejecución. Esos dos commits no cierran el criterio: la casilla padre sigue abierta y la versión publicada del cierre todavía no es la final.

Siguen abiertos, y no se esconden detrás de un después, los huecos de los criterios 1 a 4, 6 y 8, más los que la tabla de funciones deja en rojo o sin E2E. El detalle está en la última sección.

PENDIENTE: el commit del candidato final, la igualdad entre ese commit y lo publicado, la lectura de la guía y de la operación contra ese despliegue, y el pronunciamiento explícito de cada pendiente crítico que siga abierto.

## Funciones visibles de la consola

Fuente de la tabla: el mapa de vistas de esta tanda, leído sobre `console/src/nav.ts` y `console/src/App.tsx`. «Verde» en esa fuente significa dos corridas con salida 0 y un efecto afirmado. La fecha civil de esos pares no está en el mapa: PENDIENTE en todas las filas verdes, salvo que otra sección de este informe haya copiado una hora sin día.

La ruta no declarada muestra «Ruta no encontrada». La suite que lo espera (`v4-movil-adaptable-real-browser`) no entró en el par de dos verdes. PENDIENTE: esas dos corridas.

| Ruta | Vista | Estado en el mapa | Suite |
|---|---|---|---|
| `/`, `/messages`, `/messages/:tenant/:alias` | Chat | verde | `v4-chat-navigation`, `v4-chat-composer`, `v4-chat-launcher-states`, `v4-chat-voice`, `chat-file-send-real-browser`, `chat-media-real-browser`, `conversation-real-browser` |
| `/live` y alias `/office`, `/overview`, `/activity`, `/fleet`, `/topology` | Oficina | verde el campus; rojo el plano en dos suites | Campus: `v4-oficina-campus-real-browser`. Plano verde en `v4-crud-matriz-real-browser`. Rojas: `v4-office-real-browser`, `v4-console-real-browser` |
| `/accounts` (alias `/licenses`, `/assignments`) | Cuentas | verde | `accounts-assignments-real-browser`, `v4-quota-descriptor-real-browser` |
| `/my-quotas` (alias `/quotas`) | Mis cuotas | verde | Cuentas: `v4-cuotas-agent-real-browser`. Entorno: `v4-quota-environments-real-browser` (7/7 y 7/7) |
| `/queues` | Colas y DLQ | verde | `queues-dlq-real-browser` (1/1 en 37,55 s y 1/1 en 101,45 s). Cierre también en `v4-operacion-real-browser` (3/3 en 106,06 s y 3/3 en 77,05 s) |
| `/observability` (alias `/audit`, `/relays`) | Señales y auditoría | verde | `v4-operacion-real-browser` |
| `/config` | Ajustes | verde, por secciones | Query `seccion`; por defecto `general` |
| `/terminal`, `/terminal/:tenant/:alias` | Terminal | verde | `v4-cli-tty`, `v4-purga-terminal`, `v4-traslado-terminal`, `v4-cli-dynamic-terminal`, `v4-concesiones-terminal-real-browser`. Prórroga: `v4-terminal-browser` (10/10 en 93,58 s y 10/10 en 93,86 s) |
| `/ayuda` | Ayuda | verde | `v4-operacion-real-browser` recorre `#mapa`, `#terminal`, `#conceptos`, `#estados` y `#atajos` |
| `/dispositivo` | Alta de dispositivo, fuera del shell | verde | `v4-device-login-real-browser` (7/7 en 57,72 s y 7/7 en 59,99 s) |
| Ruta no declarada | 404 | sin las dos corridas | `v4-movil-adaptable-real-browser` |

`/fleet/:tenant/:alias` redirige a Terminal. El mapa no tiene una suite que afirme la URL final de cada alias. PENDIENTE: esa redirección, una a una.

Pestañas del agente: Estado, Ajustes, Ejecución, Ampliaciones y Grupos. El identificador interno de Ejecución sigue siendo el anterior; el rótulo visible es Ejecución desde `fc9b3b04`. El mapa deja en hueco la pestaña Estado como lectura en vacío.

| Sección de Ajustes | Estado en el mapa | Suite |
|---|---|---|
| `general` | verde | `v4-acceso-companies-real-browser` abre `?seccion=general`. Rollback de cadena en `v4-salas-arneses-real-browser` |
| `espacios` | verde el grupo; rojo oficina y consola ancha | `ui-crud-v35-real-browser` (3/3 en 72,11 s y 3/3 en 64,18 s). Rojas: `v4-office-real-browser`, `v4-console-real-browser`. En otra suite, Chromium revienta antes de borrar la sala |
| `agentes` | verde perfil y purga; rojo el ciclo y la cancelación | `config-profile-real-browser`, `v4-purge-real-browser` |
| `computadoras` | verde | `v4-ordenadores-real-browser` |
| `arneses` | verde | `v4-arneses-politicas-web` (14/14 en 65,47 s y 14/14 en 62,09 s), con 403 y 409 |
| `acceso` | verde | `v4-acceso-auth-real-browser`, `v4-acceso-people-flows`, `v4-acceso-clients-real-browser`, `v4-acceso-companies-real-browser`, `v4-company-admins-real-browser`, `v4-concesiones-terminal-real-browser`. `v4-people-real-browser` quedó 7/7 y 7/7 tras `319a9540` — `test(e2e): reabrir Ajustes si la recarga deja el documento vacío` |
| `avanzado` | verde la prueba de rollback; el fichero sale en 1 | `v4-salas-arneses-real-browser` pulsa «Rollback» tras «Preview del rollback» las dos veces. Cuatro pruebas posteriores revientan Chromium (9 pasadas y 4 caídas, 73,66 s y 70,64 s) |

Escrituras que el mapa no deja en verde. El orquestador no las dé por hechas:

| Acción | Estado | Suite y qué falta |
|---|---|---|
| Confirmar restauración y aplicar al agente; editor de ficheros del contexto | rojo en el mapa; verde dos veces en laboratorio después | `v4-contexts-real-browser`, `v4-context-files-real-browser`, `v4-contexto-repositorio`. El arreglo de fixture es `bfdcf15f`. PENDIENTE: fecha y producción |
| Crear persona desde la Oficina | rojo | `v4-office-real-browser`: «Crear persona» no aparece. 12 pruebas fallan y 1 pasa en cada corrida |
| Alta, edición y baja de sala o membresía desde la Oficina y la consola ancha | rojo | `v4-office-real-browser`, `v4-console-real-browser`. La baja de sala por el formulario de grupos está en verde en `ui-crud-v35-real-browser` |
| Ciclo crear, actualizar, parar, retirar y purgar | rojo | `v4-fleet-cycle-real-browser`: `STEP_FAILED` en el paso `revoke` |
| Cancelar una actualización de flota | rojo | `v4-fleet-cancel-update-real-browser`: no llega a `cancelled` |
| Inicio de sesión del proveedor | rojo el efecto | `v4-agentes-q-real-browser` abre el diálogo y no afirma el `POST` (6/6 y 6/6). `v4-agentes-h-real-browser` falla las dos veces: el terminal de laboratorio no llega a la línea de éxito |
| Verificar operación nativa pendiente | sin E2E | Ninguna suite pulsa el `POST` de recuperación |
| Recrear contenedor e iniciar sesión | sin E2E | Solo con deriva de runtime. El refresco de imagen está en verde por otro camino: `v4-fleet-image-refresh-real`, `v4-fleet-image-refresh-release-real` |
| Historial y purga de una sala o grupo | sin E2E | `RemovalDialog`. Borrar la sala por el formulario de configuración es otra llamada |
| Releer respuesta; caminar, cámara, gestos y probar el estado del icono | sin E2E | No escriben. El tono ±5° sí escribe y es la suite nueva `v4-appearance-nudge-real-browser` |
| Subir o bajar el tono 5° | suite nueva, dos verdes en laboratorio | `2b982003`. PENDIENTE: fecha |

El texto de rechazo del entorno de cuota que afirma la suite verde es el de la interfaz: «El servidor rechazó el campo nombre. Revísalo e inténtalo de nuevo.» Un entorno `ready` sin sesión muestra «Sin sesión».

## Funciones visibles del CLI

La entrada está en `ops/cli/cauce` y en [`docs/v4-cli.md`](v4-cli.md). Una fila sin dos corridas fechadas no cierra su criterio.

| Comando | Qué hace | Cobertura que este esqueleto puede citar |
|---|---|---|
| `cauce diagnose` | Diagnóstico de solo lectura de la empresa de la sesión | PENDIENTE: dos corridas con fecha |
| `cauce login`, `cauce login --dispositivo` | Sesión nominal. La aprobación humana está en `/dispositivo` | Consola: `v4-device-login-real-browser`, dos verdes, fecha PENDIENTE. La guía dice que `v4-cli-dynamic-terminal` ejecuta `cauce login` y `cauce <alias>` en local. PENDIENTE: dos corridas fechadas de ese recorrido, y el criterio 3 en el despliegue |
| `cauce <alias>` con sesión | Terminal por el gateway, sin inventario local | `v4-cli-tty`, `v4-cli-dynamic-terminal`, `v4-purga-terminal`, `v4-traslado-terminal`. Purga de terminal: dos corridas de laboratorio, 1/1, inicio 05:01:19 UTC (23,12 s) y 05:02:03 UTC (24,50 s). Fecha civil PENDIENTE. La casilla de `GOAL.md` sigue abierta |
| `cauce context` | Lectura y edición versionada | `7d2f38d3`, dos verdes en laboratorio. Fecha PENDIENTE. `apply` no acredita el consumo |
| `cauce context-native` | Ingesta de una lista explícita de archivos | PENDIENTE: dos corridas con fecha |
| `cauce spaces list`, `create`, `edit`, `retire` | Registro durable. La previsualización es el modo por defecto | PENDIENTE: dos corridas con fecha. La guía lo describe como recorrido de laboratorio |
| `cauce spaces backup`, `cauce spaces restore` | Copia y restauración local del contenido permitido | Consola verde en `v4-space-backups-real-browser`, fecha PENDIENTE. Restauración de producción del 18-oct: criterio 7. Identidad distinta: el runbook dice que la herramienta rechaza el destino |
| `cauce spaces inventory`, `migrate` | Inventario y migración. `inventory` exige `--dry-run`; `migrate` exige `--workspace` | PENDIENTE: dos corridas con fecha |
| `cauce hosts enroll`, `heartbeat`, `setup`, `status` | Enrolamiento, presencia y preparación del ejecutor | Consola de ordenadores: `v4-ordenadores-real-browser`. El CLI de setup en el despliegue: PENDIENTE dos corridas con fecha. Preparar dos identidades: [operación](operacion.md#preparar-varias-identidades-en-un-ordenador) |
| `cauce platform` | Catálogo, transferencia, siembra, empresas y enlaces | Rollback también lo hace `v4-cli-lifecycle`, fuera del botón. PENDIENTE: dos corridas fechadas del resto |
| `cauce`, `flota`, `estado`, `ver`, `sesiones` | Despacho legado de inventario | `[local real]` el CLI conserva el despacho previo (criterio 3). PENDIENTE: dos corridas fechadas |
| `cauce <alias> on`, `off`, `retirar`, `aprovisionar` | Mutaciones locales. Con estado de flota dinámica quedan bloqueadas y el aviso manda a la consola | No sustituyen el ciclo de la consola. El ciclo web sigue en rojo |
| `cauce cuotas` | Abre el CLI de cuotas del ordenador configurado. El destino no forma parte del contrato público | Criterio 4, comprobación del 18-oct a 0 puntos. El lector «según harness» sigue ausente |
| `cauce pila-test` | Solo existe en el repositorio. En flota dinámica sale 2 | No es una función de producción |

## Operación y recuperación

Los procedimientos no se copian aquí. Se siguen en el manual.

- [Desplegar V4](operacion.md#desplegar-v4), dentro de [Desplegar](operacion.md#1-desplegar).
- [Enclave de autoridad firmada de la flota](operacion.md#enclave-de-autoridad-firmada-de-la-flota) y [el controlador](v3.5-controlador-despliegue.md).
- [Roles de mínimo privilegio](runbook-rol-runtime.md).
- [Consola en 502 después de reiniciar el VPS](operacion.md#consola-en-502-después-de-reiniciar-el-vps).
- [Identidad rechazada del arriendo](operacion.md#identidad-rechazada-del-arriendo).
- [Alta y baja de un agente](operacion.md#2-alta-y-baja-de-un-agente).
- [Diagnóstico y recuperación de un adaptador caído](operacion.md#3-diagnóstico-y-recuperación-de-un-adaptador-caído).
- [Plano PTY](operacion.md#4-plano-pty-detectar-y-segar-bucles-del-relay) y [terminales](terminal-pty.md).
- [Backups y timers](operacion.md#5-backups-y-timers).
- [Smoke](operacion.md#6-smoke-y-comprobaciones-rápidas-de-salud).
- [Recuperación puntual](operacion.md#recuperación-puntual):
  - [Preparar varias identidades en un ordenador](operacion.md#preparar-varias-identidades-en-un-ordenador).
  - [Actualizar un adaptador vivo](operacion.md#actualizar-un-adaptador-vivo).
  - [Autoridad PTY](operacion.md#autoridad-pty).
  - [Lease tomado por una unidad heredada](operacion.md#lease-tomado-por-una-unidad-heredada).
  - [Disco lleno por despliegues](operacion.md#disco-lleno-por-despliegues).
  - [Copias de espacios y sincronización de contextos](operacion.md#copias-de-espacios-y-sincronización-de-contextos).
- [Runbook de copias](v4-runbook-copias.md).
- [Archivos y contextos](v4-archivos-contextos.md).
- [Guía V4](v4-guia.md).
- [Recolector de cuotas](../ops/runbooks/quota-collector.md).
- [Reglas de oro](operacion.md#7-reglas-de-oro).

Cada despliegue actualiza este informe, como indica [Desplegar V4](operacion.md#desplegar-v4). Hasta el cierre, la fila que manda es la de `deploy/HISTORIAL.md`.

## Huecos marcados para el orquestador

PENDIENTE: cada uno de estos puntos. Ninguno queda presentado como hecho.

1. Confirmar o sustituir la fila `20261025T072919Z` / `666fe368`. Escribir el commit del candidato final, los entornos, el esquema y la ubicación final de los agentes migrados.
2. Recorrer en ese despliegue los flujos esenciales del criterio 8 y volver a probar lo que falle.
3. Fecha civil de los pares en verde del mapa de vistas, de `v4-appearance-nudge-real-browser`, de `7d2f38d3`, de `bfdcf15f`, de la purga de terminal y de `5a9e8d31`.
4. Aislamiento de solicitudes manipuladas contra el despliegue (criterio 1). La retirada del 17-oct sigue vigente.
5. Arranque de un agente autenticado con una cuenta real (criterio 2).
6. Hades fuera de la cancelación entre releases. Liberación ya medida el 25-oct; la memoria total de `<vps>` no bajó.
7. Terminal por CLI de la flota dinámica en el despliegue (criterio 3).
8. Entrega de prueba de Salva y de Zeus, caso astra, espera de 5 minutos ante un error inmediato de la API, y relogin de Zeus. Salva volvió a su release anterior. Kant quedó acreditado en `892b0c3f`, no en la fila posterior.
9. Lector de cuotas «según harness» dentro del contenedor, cuenta compartida por dos agentes reales y ventanas contrastadas (criterio 4).
10. Despliegue de la cadena de contexto. `applied_version` seguía en 0 en la lectura del 25-oct. Faltan Muse, el turno N+1, la concurrencia y la recuperación en producción. Primera versión de `zz-prueba-codex`, `canario2`, `canario3` y `operador-muse`.
11. Rearranque que aplique el `TMPDIR` de `space/tmp` a Operador, Perseo, Teseo, Gaia, Hegel y Argos.
12. Filas rojas que el mapa no reabrió: persona desde la oficina, salas desde la oficina y la consola ancha, ciclo de flota en `revoke`, cancelación de actualización, inicio de sesión del proveedor.
13. Tres escrituras sin E2E: operación nativa pendiente, recrear contenedor e iniciar sesión, historial y purga de sala o grupo.
14. Restauración con otra identidad, rechazada por la herramienta, y ciclo físico de reversión en un host real, que el runbook de copias dice que no está acreditado.
15. Lectura de la guía y de la operación contra el candidato final. Los commits `a3054545` y `fc9b3b04` describen funciones ya existentes. No sustituyen esa lectura.
