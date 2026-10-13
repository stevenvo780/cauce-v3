# Completar Cauce V4 — goal de cierre

Completa Cauce V4 como un sistema totalmente funcional, multiempresa y multitenant. No quiero maquetas, funcionalidades únicamente documentadas ni pantallas desconectadas de las operaciones reales. Todo lo que se pueda hacer desde la interfaz debe ejecutar la acción correspondiente, reflejar su estado real y estar correctamente probado.

Aprovecha los mecanismos que ya funcionan, especialmente las terminales remotas, la comunicación entre agentes, el CLI de Cauce y la lectura de cuotas mediante los CLI de los proveedores. Revisa la implementación existente antes de añadir componentes nuevos: la prioridad es integrar, simplificar y completar el sistema, no duplicarlo.

**La tarea incluye implementar, migrar, desplegar y verificar. No termina al escribir el código ni al entregar un plan.**

> Este goal reemplaza al original que se le dio a GPT y conserva todos sus requisitos y criterios de aceptación. Cada requisito lleva su estado verificado: `[x]` cumplido (con el nivel de evidencia: **[código]**, **[local real]** = probado en local con PostgreSQL, Docker, Git o Chromium reales, **[desplegado]**) y `[ ]` pendiente. El detalle tarea por tarea, con el criterio exacto de comprobación, está en `ordenes/v4-cierre-objetivo.md` de la rama `claude/v4-cierre`. El texto literal del dueño está en `docs/v4-objetivo-del-dueno.md` y es la especificación vinculante: los resúmenes de cada sección no reducen su alcance y, ante cualquier diferencia, prevalece el texto literal.

## 0. Punto de partida (verificado el 12-oct-2026)

Auditoría de la rama de GPT con 34 agentes Haiku, 15 Sonnet y pasada final de 8 revisores Opus 5.5. **Avance real: ~35 %** frente a los criterios (código ~70 %, probado en local con componentes reales ~35 %, desplegado 0 %). GPT declaró 55 % porque midió esfuerzo, no aceptación.

| Aspecto | Estado |
|---|---|
| Git | **Limpio.** `dev` = `main` = `origin/dev` = `origin/main` = `94959fb0`, sin cambios ni stash. Integración en **`claude/v4-cierre`** (= `codex/v4-complete` `56c0c016` + goal), publicada en origin. Ramas locales: `main`, `dev`, `claude/v4-cierre`. Remotas además de esas: `codex/v4-complete` (PR #151, con **GitGuardian en rojo, 6 secretos**) y las 6 fuentes de port de la sección «Trabajo a portar». Se borraron 172 ramas locales y 164 remotas, 48 worktrees, 35 registros de worktrees muertos, 6 refs huérfanas y el stash; se cerraron los PRs superados #136, #142, #143 y #148. Todo es recuperable: bundle verificado de todas las refs, cambios sin commitear y material a portar en `<respaldo-local>/ramas-20261012/` (subcarpeta `portar/`). |
| Espacio de trabajo | **Un solo Cauce**: la raíz del repositorio, con la rama `claude/v4-cierre`; `dev`, `main` y las demás versiones viven solo como ramas de git. Sin worktrees ni copias adicionales en el workspace. Dependencias con `pnpm install --frozen-lockfile` y venv único `~/.venvs/cauce-qa` (jsonschema, pyyaml, ruff, shellcheck). Gates del HEAD: **typecheck 0, lint 0, test:unit 0**. `pnpm test` completo y cobertura del SHA final: pendientes (el último release de GPT cayó por cobertura de consola: 87,16 % < 94,69 %). |
| Carriles de delegación | 4 sesiones tmux con la **TUI interactiva** (puedes entrar con `tmux attach -t <sesión>` e intervenir): `cauce-codex-1`, `cauce-codex-2` (gpt-6.1-sol, esfuerzo `ultra`) y `cauce-muse-1`, `cauce-muse-2` (muse-wonder-full-1.0, esfuerzo `max`: `ultra` lo bloquea un gate del proveedor en esta cuenta). Todas trabajan en el mismo checkout. Kit en `.delegados/v4/` dentro del repo (excluido de git): `arrancar.sh`, `delegar.sh <carril> <tarea.md>` (teclea la tarea en la TUI), `estado.sh` (estado y pantalla de cada carril), `detener.sh`, reglas en `comun.md`. Humo verificado en los 4. |
| Producción | VPS (IP pública de producción) corre **V3** (`34cd5ea0`, esquema 051), contenida en V4. RAM 62 GiB (30 disponibles), **swap 9/9 GiB llena**, disco 83 %. |
| Hospital (Praxis) | `ssh hospital` (`vps-990525f1`, ubuntu con sudo). Corre código de `origin/socrates/hospital-supervision-1699` (runtime `da8d921bc`, adapters `72727a16`/`1fe69c1f`) **que no está en V4**. Cauce se retirará de esa máquina y la VPS se apagará. |
| Servidores locales | server1 (IP de la LAN del host) (~11,8 GB RAM libres, 261 GB, sin Docker); server2 (IP de la LAN del host) (~11,7 GB, ~143 GiB, Docker; ya aloja Salva y los `cuota-cli`); server3 sin verificar. |

## Modelos, del más al menos capaz, y canal de cada uno

Orden según el Artificial Analysis Intelligence Index (12-oct-2026, máximo esfuerzo). Toda entrega delegada la revisa otro modelo; la **revisión final es siempre de Opus 5.5**.

| # | Modelo | Índice | Canal | Mejor uso |
|---|---|---|---|---|
| 1 | **Claude Opus 5.5** | 58 | Orquestador y workflows | Lo más duro: arquitectura, integración, migraciones, despliegue, verificación adversarial, revisión final. También el mejor en diseño visual y UI. |
| 2 | **Claude Sonnet 5.5** | 56 | Workflows | Código de complejidad media y **consola/UI**, el doble de rápido que Opus. |
| 2 | **Muse Wonder Full** `max` | 56 | tmux `cauce-muse-1`, `cauce-muse-2` | Implementación de funcionalidades de punta a punta. Recién publicado: las primeras tareas sirven para calibrarlo. |
| 4 | **GPT-6.1 Sol** `ultra` | 52 | tmux `cauce-codex-1`, `cauce-codex-2` | Código backend y **pruebas** (Codex lidera Terminal-Bench y DeepSWE); el más eficiente por tarea de los fuertes. |
| 5 | Grok 4.7 | 46 | `cloud-offload` | Opcional. |
| 6 | **Claude Haiku 5.5** | 43 | Workflows | Tareas repetitivas, inventarios y revisiones de primera pasada; muy rápido y barato. |
| 7 | GPT-6-Luna | 38 | `cloud-offload` (si no responde, `codex exec -m gpt-6-luna`) | Repetitivo de bajo riesgo, por debajo de Haiku. |

Fuera del pool: Fable 5.1 (53, más caro y peor que Opus), MiniMax, Gemini y Qwen.

Frentes por carril tmux:
- `cauce-codex-1`: backend, store, migraciones y seguridad, con sus pruebas.
- `cauce-codex-2`: pruebas e infraestructura: e2e versionados, simulacros de fallo, executor y CLI.
- `cauce-muse-1` y `cauce-muse-2`: funcionalidades completas (harnesses por descriptor, contextos y broker Git, port del hospital y de OAuth).
- La consola y la UI las escribe Sonnet en workflows, con revisión de Opus.

Reglas de delegación:
- Tareas acotadas (una a dos horas) con sección `## Archivos`. Si Codex se corta con `stream disconnected`, se reintenta.
- Un solo checkout sobre `claude/v4-cierre`, con el protocolo de `AGENTS.md`: archivos disjuntos, commits con pathspec, sin cambiar de rama ni stash ni reset.
- Antes de repartir, `get_ai_quotas`. Si un proveedor está agotado, se pasa al siguiente del orden.

## Reglas de ejecución (lecciones de la ejecución anterior)

1. Nada de maquinaria nueva de despliegue: ni observadores, ni controladores, ni «holds». Se despliega con `deploy/deploy.sh` (`CAUCE_DEPLOY_FLEET_OVERLAY=1`), `host-backup.sh`, `build-adapter-release.sh` y `fleet-controller-upgrade.py`.
2. Un gate completo por candidato y, con verde, se despliega el mismo día. Durante el desarrollo, pruebas focales.
3. Los recibos van con SHA, comando, exit y log, en el repo o en un directorio durable, nunca en `/tmp`. Los drivers de prueba se versionan en `tests/`.
4. Un único informe de estado (`docs/v4-informe-final.md`) con los tres niveles separados.
5. Cada componente nuevo reemplaza algo o justifica por qué no (Regla 0).
6. Recorrer los flujos como usuario antes de pulir la verificación.
7. No se borra el origen de ningún agente sin verificación en destino y copia offsite. Los recursos de prueba llevan el prefijo `zz-canary-<run>` y se limpian.

## 1. Multiempresa, registro y aislamiento

Todo el sistema debe ser multitenant. **Humanizar** y **Praxis** deben quedar completamente funcionales con sus usuarios, agentes, ordenadores, salas, clientes, credenciales y configuraciones. Cualquier persona debe poder registrarse, crear su propia empresa y registrar sus ordenadores sin configuración manual del administrador. El aislamiento entre empresas se aplica en interfaz, backend, comunicaciones y operaciones remotas. Revisa y simplifica las membresías sin perder los controles necesarios.

- [x] [código] Esquema multiempresa 051–065. 053 bloquea en BD, con 33 triggers, escrituras y referencias entre empresas. API y UI de empresas (alta, edición con CAS, retiro con datos conservados) y admins por empresa.
- [x] [local real] Unas 110 pruebas PostgreSQL multiempresa y recorrido Chromium+PG: crear empresa con dueño, editar, retirar revocando autoridad.
- [x] [local real] Registro público atómico (`/v3/auth/register` + `cauce_register_company`): un usuario nuevo se registra, crea su empresa y entra como owner.
- [x] [local real] Enrolamiento de ordenadores por invitación de un solo uso, con claim Ed25519 y heartbeat firmado.
- [x] [código] Membresías con función real conservadas (`console_users`, `human_tenant_memberships`, `company_admins`, `platform_admins`).
- [ ] Humanizar real en V4: ensayo 051→065 sobre dump fresco, siembra de super-admin (Steven) y owners (Steven, Miguel).
- [ ] Praxis real: empresa con León como owner (Claude crea su usuario), recursos del hospital importados por `cauce platform change` y agentes migrados a servidores locales (ver §5).
- [ ] Un ordenador recién enrolado ejecuta agentes sin el administrador (falta el instalador del executor y de su política firmada).
- [x] [local real] Limitador de registro y claim por IP real: `realip` de nginx tras Caddy y `trustProxy` acotado que falla cerrado, IPv6 por /64 (nginx y gateway reales en pruebas; 4830497d, 5f64c05a). Falta fijar `CAUCE_FRONT_PROXY_CIDR` y `CAUCE_TRUSTED_PROXY_CIDRS` en producción.
- [x] [local real] Guardia adversarial que enumera las 173 rutas `/v3` y WS con dos empresas y huellas de filas (2f1080c8): encontró 2 fugas reales (existencia de hosts y poda global de cuotas) y 3 contratos 400/409, en corrección.
- [ ] Prueba adversarial en verde sin excepciones y repetida contra el despliegue.
- [ ] Simplificación de membresías aplicada con su migración y su down (propuesta revisada en `docs/v4-membresias.md`; la migración será la 068).

## 2. Credenciales y cuotas por agente

Espacio para administrar credenciales y cuentas de proveedores, con aislamiento y sin exponer secretos. La cuota se consulta en el ordenador donde corre el agente, según su harness, y se muestra en la web con saldo, ventanas y reinicios reales. **Varias cuentas compartidas entre agentes son válidas y no un error.** Estado y hora de actualización siempre visibles; sin valores inventados.

- [x] [local real] CRUD de cuentas con CAS y aislamiento entre empresas; la proyección pública no expone credenciales; la identidad remota se guarda como hash.
- [x] [código] Recetas de cuota por harness (claude, codex, grok) sobre el executor y la terminal remota existentes.
- [x] [código] La ficha del agente muestra ventanas, % disponible, reinicio y fecha de la cuenta vinculada.
- [x] [código] Solo se muestran las ventanas que informa cada proveedor (Claude 5 h/7 d, Codex por duración y modelo, Grok por periodo).
- [x] [local real] Cuenta compartida con aviso «Consumo compartido por N agentes», sin saldos independientes; estados ok/antiguo/desconocido/error; un 429 no se convierte en agotamiento.
- [ ] Consultar la cuota en el contenedor donde corre el agente y vincular los agentes reales a su cuenta.
- [x] [local real] Compartir cuenta ya no es error: el guardián y `cred-guard.py` lo anotan como nota informativa y solo escalan fallos reales; `shared` se calcula con todas las asignaciones de la empresa antes del filtro por tenant (PG; 51c9fd37, 6e05b7d8, c25cc0e6).
- [x] [código] Motivo de cada fallo con seis códigos cerrados de lector a consola, con su acción en español; «Pendiente de autenticación» en cuentas recién creadas (de037ec7, 365d9faf, 6a6ed3ea, 7fc7d7b5).
- [x] Lectores para openclaw y muse, o «sin lector» explícito.
- [ ] Contraste en producción de las ventanas mostradas con `coutas`; auditoría de logs sin secretos.

## 3. Espacio «Mis cuotas»

Registrar y consultar cuentas sin agente, instanciar un entorno Docker aislado con el CLI del proveedor y una terminal restringida a autenticar, consultar y mantener; actualizar el CLI y administrar el ciclo de vida desde la interfaz; vista gráfica con tarjetas fijadas, distinta de la vista por agente; consultar mis cuotas desde Cauce sin abrir una terminal.

- [x] [local real] Cuentas sin agente: alta, edición y borrado con pines por persona y empresa que persisten en otro navegador.
- [x] [código] Entorno endurecido (`--read-only`, `cap-drop ALL`, `no-new-privileges`, límites), operaciones tipadas sin shell, login con comando fijo del descriptor y PTY acotado.
- [x] [local real] Cola durable con CAS y fencing para create/authenticate/query/update_cli/delete.
- [ ] Imagen de cuotas construida con versiones fijadas y su digest en la política; host con ejecutor de cuotas (server2).
- [ ] Ciclo Docker real desde la web: crear, autenticar (el dueño aprueba el código con las cuentas `cuota-claude-1`, `cuota-codex-b2b`, `cuota-grok-1`), consultar, `update_cli` y eliminar, más una prueba de escape del PTY.
- [x] [código] **Refresco de token restaurado** solo en entornos de «Mis cuotas» con sesión propia (flag explícito, nunca en contenedores de agentes), con candado, relectura y escritura atómica 0600 (25a27a83, 365d9faf, 425cd569). Falta el recibo real de un entorno autenticado hace >9 h.
- [ ] Habilitar Grok (paquete e identidad) y dejar de ofrecer proveedores sin ejecutor (gemini).
- [ ] Datos frescos sin pulsar botones (consulta al abrir la vista si la captura tiene >10 min) y prueba de uso cotidiano 24 h después en producción.

## 4. Oficina interactiva y configurable

La oficina refleja los recursos reales de cada empresa, permite entrar al detalle de cada agente (información, estado, contextos y cuotas), muestra el **«cansancio»** distinguiendo disponible, cerca de agotarse, sin disponibilidad, sin datos y error, y es editable sin distribución fija; los cambios persisten tras recargar, iniciar sesión de nuevo o usar otro navegador.

- [x] [código] Plano y campus derivan salas y agentes de la topología, sin agentes fijos en el código.
- [x] [código] El detalle del agente abre su estado, cola, cuotas y «Perfil y contexto» con historial, diferencias y restauración.
- [x] [código] El cansancio distingue sin datos, error, antiguo, agotado, cansado (<25 %), pausa y «varía por modelo», en plano, campus y ficha.
- [x] [local real] Editor de salas y partes con validación y CAS; el plano persiste tras recargar y en un segundo navegador.
- [x] [local real] La topología y el plano usan la empresa activa: tras cambiar de empresa solo se ven sus salas y guardar el plano da 200 (PG; 022e0ee6, e3c63b0d).
- [x] [código] El campus ordena sus edificios por la posición guardada en el plano y muestra «Leyendo cuotas…» al cargar (b86f7443, 42ac20fa).
- [ ] e2e de alta, edición, asignación y baja de salas y agentes en la oficina, con re-login y segundo navegador; contraste del cansancio con cuotas reales en producción.

## 5. Migración de agentes a servidores locales

Mueve a **Gaia, Hegel, Hades y Argos** a servidores de la red local para liberar la VPS principal. **Kant** conoce la infraestructura: pregúntale por Cauce. Mide RAM y disco, distribuye según capacidad, migra configuración, contextos, datos y espacios sin trasladar el desorden, verifica credenciales, permisos y conexiones, no borres el origen sin verificación y copia recuperable, libera los recursos y compara la VPS antes y después.

**Ampliación del dueño (12-oct-2026):** Cauce se retira también de la máquina del hospital. **Los agentes de Praxis** (muse frontend/backend, openclaw operator y sales, crm) se mueven a los servidores locales y esa VPS se apagará; lo publicado del hospital irá a otra infraestructura más barata, por decidir. La VPS principal sigue alojando Cauce central.

- [x] [local real] Relocalización entre hosts con slices selladas y coordinador (PG).
- [x] [código] Precedente en producción de agente fuera de la VPS: Salva en server2 (`dockerHost`).
- [x] [local real] Tamaños de los cuatro espacios medidos sin leer contenido. Gaia 3 MB, Hades 498 MB, Argos 52 MB y Hegel 30 KB propios; los 30,5 GB de Hegel son el `/workspace` compartido.
- [ ] Hallazgo: la flota V4 solo puede colocar hoy a Argos. Gaia (openclaw+Anthropic), Hades (grok) y Hegel (muse) necesitan drivers de flota por descriptor (§7); el respaldo es el overlay V3 `dockerHost=server2`.
- [ ] Preguntar a Kant por Cauce; medir en el día; ubicar los cuatro en server2 con `--memory` por contenedor, con server1 de reserva.
- [ ] Registrar bindings reales (cuenta, modelo, pagador) sin cambiar de cuenta; **copiar en privado** las sesiones a server2 (SSH, 0600, sin copias, Git ni logs), decisión del dueño.
- [ ] Copia recuperable y ensayo de reversión antes de cada corte; proyectos por git y datos con manifiesto; normalizar el layout durante el traslado.
- [ ] Canario Gaia, luego Hades, Argos y Hegel (Hegel con espacio propio y sus repos, sin tocar `ws-humanizar`). Por alias: nonce por Cauce, terminal por CLI y web, cuota, contexto aplicado y host en la UI. Tras el traslado, además: una edición de contexto desde la UI crea la versión N+1, sincronizada y ligada al mismo historial del alias, y una operación de la UI (detener y arrancar) se aplica en el host nuevo.
- [ ] Liberación del origen tras 7 días y medición VPS antes y después con un único script.
- [ ] Praxis: portar a V4 los arreglos del hospital (`socrates/hospital-supervision-1699`), inventariar sus agentes y servicios, migrarlos a los servidores locales con el mismo procedimiento, verificar y retirar Cauce del hospital antes de apagar la VPS.

## 6. Gestión de recursos, Docker y CLI de Cauce

CRUD completo y real de todas las entidades desde la interfaz, con efecto en el entorno real; orquestador de espacios Docker (elegir ordenador, instanciar, administrar y eliminar); el CLI `cauce` conserva sus capacidades y facilita crear espacios; copias descargables del contenido persistente con recuperación documentada; estados reales pendiente / en ejecución / completada / fallida; reintentos sin duplicados ni huérfanos.

- [x] [local real] CRUD en Chromium+PG de clientes (= tenants), salas, membresías, registro de agente, empresas, cuentas, plano e invitaciones.
- [x] [local real] Executor contra Docker real local: create, prepare, stop y purge.
- [x] [código] Operaciones de flota con preview, enqueue, CAS y fencing; retiro reversible y purga; el servidor rechaza pasos sin evidencia.
- [x] [local real] CLI: despacho previo intacto más `platform`, `hosts`, `context`, `spaces`.
- [x] [local real] Copias con sha256, identidad y omisiones (PG 16/16; restauración CLI de >96 MiB).
- [ ] Ciclo físico desde la web en Docker local y en server2: crear, editar la configuración, los componentes y las asignaciones del agente (operación update) con efecto comprobado en el contenedor, aplicar contexto, detener, retirar y purgar. Instalar en el VPS el enclave de autoridad firmado.
- [x] [código] Copias de hasta 1 GiB descargadas por enlace sin buffering con su SHA-256 visible; el filtro omite solo credenciales reales (archivos, directorios y tokens por contenido) e incluye el código con `auth|session|token` en el nombre; `.git` se omite con motivo `vcs_metadata` en el manifiesto (feda39de, 4a3a5a00, 08ea438f, 22b98c0d, 9f0a61d3).
- [ ] Purga honesta (nombra contenedor y volúmenes, confirma con el alias) y sin huérfanos (`-provider-profiles`, create fallido); barrido de huérfanos como paso del gate, en ambos sentidos: recursos `cauce.fleet.*` sin fila y filas de agente o placement sin recurso real o con un estado distinto del de Docker.
- [ ] Terminal por CLI (`cauce <alias>`) para agentes en flota dinámica; `cauce login` y `cauce spaces create|list|edit|retire`.
- [ ] e2e real para ordenadores, personas, entornos de cuota y contextos; matriz CRUD verificable por máquina; runbook de recuperación de copias; pruebas físicas de interrupción.

## 7. Sistema extensible de harnesses

Incorporar un harness debe ser una operación clara mediante configuración JSON/YAML interpretada por el sistema (instalar, configurar, autenticar, ejecutar, actualizar, consultar cuota), validada con errores comprensibles y con capacidades en la UI iguales a lo ejecutable; documentado y probado.

- [x] [código] 8 descriptores JSON validados, empaquetados y fijados por digest, con parsers cerrados en TS y Python.
- [x] [local real] En «Mis cuotas», las capacidades salen del descriptor aprobado y un descriptor alterado retira la capacidad.
- [x] [código] Los comandos (login, cuota, paquete de update, módulo de flota) pasan al descriptor y salen de `harness_operations.py`. (ccf554d1, 75ddb35d)
- [x] [código] Las listas de runtime se derivan de los descriptores, con test de paridad para enums, el CHECK SQL y la consola. (27200201)
- [ ] Flota por descriptor con autenticación para grok, muse y openclaw+Anthropic (necesario para la migración).
- [x] [código] Descriptores honestos; errores con campo y motivo; capacidades por acción. (ccf554d1, 27200201)
- [ ] Alta de punta a punta de un harness de prueba (`fake2`) y operaciones físicas de quota y update en server2, con runbook.

## 8. Reorganización de archivos y versionado de contextos con GitHub

Estructura estándar de espacios (contextos/directivas, proyectos, configuración no sensible, datos, registros, temporales), usada de verdad por backend, CLI, contenedores, UI y copias, migrada sin pérdida. Un único repositorio privado compartido (`tenants/<tenant>/agents/<agent>/context/`) con aislamiento, identificadores estables, registro de cada cambio con autor y fecha, todas las vías de edición, estados local / Git / GitHub distinguidos, concurrencia sin pérdidas, historial, diff y restauración desde la UI, aplicación efectiva al agente y sin secretos.

- [x] [código] Layout estándar (`prepareSpaceLayout`, `CAUCE_SPACE_ROOT` derivado y verificado por el executor V4, materialización por turno) y copias con allowlist y exclusión de secretos probada.
- [x] [local real] Aislamiento entre empresas en el repo compartido e **identidad estable** (alias inmutable; nombre y sala editables sin perder historial).
- [x] [local real] **Registro** con contenido, digest, origen, autor y fecha; Git solo con `context/` y `directives/` de texto y escaneo de secretos.
- [x] [local real] Broker Git con CAS y replay; push fallido recuperable; estados separados; concurrencia por agente con CAS; historial, diff y restauración como versión nueva (backend).
- [x] [local real] Transporte a GitHub privado `stevenvo780/cauce-agent-contexts` probado con contenido sintético.
- [ ] `CAUCE_SPACE_ROOT` en el supervisor legacy y `cwd` en `space/projects`; productores de `tmp/` y `logs/`; inventario y migración verificable de los espacios reales: diff de manifiestos sin pérdidas y, por cada agente migrado in situ, un turno real (nonce) que responde leyendo desde la nueva ruta.
- [ ] Sembrar el historial de los agentes reales y empujarlo a GitHub; preflight del repo del broker en la VPS.
- [x] [local real] **Versionar las ediciones hechas en el espacio del agente**: hoy no se registran y además bloquean sus turnos. (0e186764, adc0bf9d, 341d4dbc, 99683b04)
- [ ] Turno real que adopte la versión; una sola fuente de contexto (`CLAUDE.md`/`AGENTS.md` generados desde la versión aplicada).
- [ ] Recuperación de divergencia (fetch antes del commit), concurrencia multiagente, autor en el historial, lector V3 desacoplado y fallo de sync ensayado en producción.

## 9. Auditoría, diagnóstico y eliminación de código innecesario

Revisar los mecanismos por su uso real, eliminar lo que no aporta y quedarse con un diagnóstico pequeño y efectivo que relacione cada operación con empresa, agente, ordenador y componente, reconstruya cadenas de fallo e incluya infraestructura y sincronización de contextos, sin capas de apariencia.

- [x] [código] Ids de cadena existentes de extremo a extremo (`trace_id` de mensajes, sesión de terminal, `operation_id` de flota) y `audit_events` con empresa y actor.
- [x] Inventario de uso real medido en producción en solo lectura, con productores, lectores y decisión por mecanismo (`docs/v4-diagnostico.md`; ec1dff01, 2a64d09f).
- [ ] Poda: cinco guardias de credenciales solapadas, doble escritura JSONL+PG de decisiones y lector V3 de contextos, con regresión en verde (hoy V4 no borró ni un archivo).
- [ ] Lectura de auditoría por empresa con filtros en servidor; consulta de cadena por id; causas saneadas de fallos de sync; ensayo de cuatro rupturas reales localizadas solo con los registros.

## 10. UI/UX, pruebas y documentación

Vistas completas y cuidadas, CRUD probado de punta a punta con efectos reales, pruebas unitarias, de integración y e2e reales (no solo mocks), fallos de SSH, CLI, reinicios y conflictos, recursos de prueba identificables y limpiados, y documentación de todo lo real.

- [x] [local real] Matriz `pnpm test` 12/12 sobre `533d245e`; SSH real (sshd efímero), Docker real, PTY real y GitHub sintético real.
- [x] [local real] 17 e2e con navegador real (vistas V3) y recorrido V4 de 12 pasos en Chromium+PG (fuera del repo).
- [ ] Todas las vistas con estados vacío, de carga y de error resueltos; formularios que validan sus entradas; cada acción con retroalimentación clara (éxito, error con motivo, en curso). Se comprueba en el e2e V4 y en `qa:layout`.
- [ ] Versionar el e2e V4 en `tests/e2e`; rutas V4 en `qa:layout`; pruebas de fallo con procesos reales; tabla de pruebas reales por categoría.
- [ ] `docs/v4-guia.md` y la subsección «Desplegar V4» de `docs/operacion.md` documentan el comportamiento real entregado, incluidos los procedimientos de operación y recuperación, en estas áreas: uso desde la interfaz, administración, CLI, arquitectura multitenant, registro de ordenadores, gestión de agentes, harnesses, credenciales, cuotas, oficina, estructura de archivos, integración con GitHub, migraciones, copias de seguridad, restauración, despliegue y diagnóstico. Además, corregir los docs desfasados y quitar las 57 rutas privadas.

## 11. Ejecución, despliegue y máxima paralelización

Máxima paralelización efectiva con revisión independiente; entorno local real; ciclos **implementar → probar en local → desplegar → probar lo desplegado → corregir → volver a desplegar y verificar**; copias y reversión antes de tocar datos. El despliegue forma parte de la tarea y está autorizado dentro de los entornos de Cauce y los accesos disponibles, respetando su configuración de acceso y privacidad: no se para en «listo para desplegar» ni se evita desplegar por cautela genérica. La paralelización acelera la entrega sin saturar los servidores, sin agotar los recursos que necesitan los agentes operativos (la VPS ya tiene la swap llena; server2 aloja a Kant, Salva y los `cuota-cli`) y sin comprometer la integridad de los datos. La revisión independiente, de un revisor distinto del autor, cubre seguridad, regresiones, casos límite y experiencia de usuario.

- [x] Equipo de modelos y 4 carriles tmux listos (ver tiers); entorno local reproducible; git limpio y respaldado.
- [x] [local real] Backup predeploy del 12-oct aprobado (ya caducado para la ventana real); restore aislado de producción con 052–064 y datos intactos.
- [x] Contraseñas de fixture sustituidas por placeholders construidos en ejecución (41a2fda6) e ids y correos del dueño fuera de `ops/cuotas` (75ddb35d). **Dueño:** marcar los falsos positivos históricos en GitGuardian.
- [ ] Gate completo una vez por candidato (incluida cobertura de consola ≥ 94,49 %) y revisión Opus del diff.
- [x] [local real] Ensayo 052–065 sobre el dump de producción del 12-oct: 307 279 filas intactas, transacción de 663 ms, contención que falla sin aplicar nada y reversión real 065→051→065 con los `down` corregidos (4924052c, b976df33).
- [ ] Merge a `dev` y fast-forward de `main`.
- [ ] Prechequeo del VPS, backup fresco, `deploy.sh` y kit del controlador de flota; humo y ciclo completo hasta 0 flujos esenciales en rojo; versión publicada = código verificado.

## Trabajo a portar de ramas antiguas

Verificado por contenido (Haiku/Sonnet + revisión Opus 5.5): trabajo valioso que no está en V4. Se porta a `claude/v4-cierre` con prueba focal, y la rama fuente se borra al terminar.

- [x] [local real] (P0) **Hospital (Praxis), supervisión y Muse** (98696901, 91e09ba6; aislamiento del backend en bf020517): de `origin/socrates/hospital-supervision-1699` (lo que corre hoy en el hospital), `ops/instances/hospital/muse-cli-backend.py` + test, el plugin `openclaw-muse-native/` + test y `packages/adapter-sdk/src/sdk/engine/conversation-status.ts` + test. No se porta el `safe.directory` de `7530677d`, porque ya está superado por `command_identity`.
- [x] [local real] (P0) **Hospital, revisión QA y continuidad** (49b34d1a, a7f544eb, 8478d526, 40e6f520, f50c8014, 8fcd3280, d403c98f, 8eb47a82): de `origin/kant/rc2-hospital-praxis-20261007`, los commits `1eeca7d9`, `ef4e1fb0`, `caac19b6`, `bc4c60de` y `9cff3b73` entran sin conflictos; `6e3bc3ff` choca en `tests/unit`. Incluye un arreglo del store que V4 no tiene: rechazar con `no_route` un publish human-mcp hacia un consumidor vivo sin la capacidad.
- [x] [código] (P1) **Renovación OAuth** (`b4cd9265`, PR #149; portada en 92112fc8): recuperación del refresh, consentimiento más claro y corrección de `ui_locales` → `invalid_request`. Las otras cuatro variantes eran copias.
- [x] [código] (P1) **Consola** (f088e262): reintentar un adjunto repite la acción que falló. Patch `08c69433` en `portar/consola-reintento-adjuntos/`; hay que ajustar `clearResource` y espiar `HTMLAnchorElement.click` en `MessageAttachments.test.tsx`.
- [ ] (P1) **Hospital, perfil de proyecto**: `ops/instances/hospital/project-profile.{py,json}` de `origin/codex/company-instances-20261006` (PR #131). El resto de esa rama (instalaciones por empresa) es una arquitectura descartada (`docs/v4-plan-multiempresa.md:41`): conservar solo su documento de diseño como referencia y cerrar el PR.
- [x] (P2) **Registros de Cronos** (836c6eec, e603d474): 6 filas de `deploy/HISTORIAL.md` y el runbook del buzón (PRs #130 y #134), ordenados por fecha.
- [x] (P2) **Pruebas y documentos sin commitear** (4c2cc25e, 93dcc8de): dos tests de regresión de `mcp-emission-outside-delivery` (`portar/tests-mcp-emission-outside-delivery.patch`), `docs/v3.5-unir-computadoras.md` (estado medido de V3.5) y los e2e en curso `context-multiuser-continuity` (adaptarlos a la autenticación por empresa o descartarlos con motivo).

## 12. Criterios obligatorios para dar por terminada la tarea

**La V4 solo puede considerarse terminada cuando se cumplan y verifiquen los siguientes criterios.** Ninguno está cumplido entero todavía; dentro de cada uno se marcan las cláusulas ya acreditadas.

- [ ] **1. Multiempresa operativa y aislada.** Humanizar y Praxis funcionan con sus recursos reales. Un usuario nuevo puede registrarse, crear su empresa y utilizarla. Las pruebas confirman que no puede acceder a datos ni ejecutar operaciones de otra empresa, tampoco manipulando solicitudes fuera de la interfaz.
  - [x] [local real] Un usuario nuevo se registra, crea su empresa y entra como owner.
  - [x] [local real] Aislamiento por familias de rutas y en BD.
  - [ ] Humanizar y Praxis con sus recursos reales.
  - [ ] Registro usable en producción.
  - [ ] Solicitudes manipuladas cubiertas de forma exhaustiva y probadas contra el despliegue.

- [ ] **2. CRUD completo y real.** Se han probado creación, consulta, edición y eliminación de todas las entidades administrables, tanto desde la interfaz como en sus efectos persistentes y remotos. No quedan botones ficticios, operaciones incompletas ni recursos huérfanos tras las pruebas.
  - [x] [local real] CRUD con persistencia de empresas, clientes, salas, membresías, registro de agente, cuentas, plano e invitaciones.
  - [x] [local real] Executor contra Docker real local.
  - [ ] Agentes, ordenadores, personas, entornos de cuota y contextos con ciclo real y efectos remotos.
  - [ ] Sin huérfanos ni controles ficticios, con barrido y matriz que lo demuestren.

- [ ] **3. Gestión distribuida funcional.** Se pueden registrar ordenadores e instanciar, administrar y eliminar espacios y agentes en ellos. Gaia, Hegel, Hades y Argos funcionan en servidores locales, conservan su información y se ha comprobado la liberación de recursos en la VPS principal. El CLI `cauce` y las terminales remotas mantienen sus capacidades.
  - [x] [local real] Enrolamiento con identidad firmada y relocalización entre hosts (PG).
  - [x] [local real] El CLI conserva su despacho previo.
  - [ ] Ordenador enrolado que ejecuta agentes sin el administrador; espacios y agentes en un host remoto real.
  - [ ] Gaia, Hegel, Hades y Argos (y los agentes de Praxis) en servidores locales con su información; liberación medida.
  - [ ] Terminal por CLI para la flota dinámica.

- [ ] **4. Cuotas reales desde la web.** Funcionan las cuotas por agente y la sección «Mis cuotas», incluyendo autenticación, consulta, actualización de CLI y administración de sus entornos. Se ha probado que varios agentes pueden compartir una cuenta sin errores ni saldos ficticiamente independientes. Las ventanas y los estados mostrados corresponden a los datos reales disponibles.
  - [x] [local real] «Mis cuotas»: cuentas sin agente y tarjetas fijadas con persistencia.
  - [x] [local real] Estados explícitos y cuenta compartida modelada sin saldos independientes.
  - [ ] Entornos Docker reales (autenticar, consultar, actualizar CLI, eliminar).
  - [ ] Cuotas por agente según harness; cuenta compartida por dos agentes reales; ventanas contrastadas; verificado en producción.

- [ ] **5. Oficina y harnesses operativos.** La oficina responde a la creación, edición, asignación y eliminación de salas y agentes; su configuración persiste; y el detalle de cada agente muestra correctamente sus cuotas y estado visual. El mecanismo de configuración de harnesses se ha probado con operaciones reales y no depende de cambios dispersos para cada integración.
  - [x] [local real] El plano persiste tras recargar y en otro navegador.
  - [x] [código] Salas y agentes dinámicos y cansancio con estados distintos.
  - [ ] Reflejo e2e de altas y bajas; campus según el plano; ficha con datos reales.
  - [ ] Harnesses con operaciones reales y alta sin cambios dispersos.

- [ ] **6. Archivos ordenados y contextos versionados.** Los espacios utilizan la estructura estándar sin pérdida de datos ni rutas rotas. El repositorio compartido de GitHub contiene las carpetas de los agentes y registra sus cambios. Se han probado la edición desde las vías soportadas, el historial, las diferencias, la restauración, la aplicación efectiva al agente, las escrituras concurrentes y la recuperación después de un fallo de sincronización, sin exponer secretos ni contextos entre empresas.
  - [x] [local real] Concurrencia con CAS sin descartar contenido; guardado, Git y sincronización separados con fallo recuperable; historial, diff y restauración; identidad estable y aislamiento en el repo.
  - [ ] Espacios reales con la estructura estándar; repo con las carpetas reales; edición por todas las vías; aplicación con turno real; recuperación ensayada en producción.

- [ ] **7. Copias, recuperación y diagnóstico comprobados.** Se puede descargar una copia del contenido de un espacio y restaurarla en un entorno de prueba. Los fallos relevantes dejan un rastro útil para encontrar su causa. La eliminación de componentes de auditoría innecesarios no ha roto funciones ni suprimido controles necesarios.
  - [x] [local real] Restauración en entorno de prueba con datos sintéticos.
  - [ ] Descarga desde la consola de una copia real y su restauración.
  - [ ] Rastro útil de fallos y poda de auditoría sin romper nada.

- [ ] **8. Pruebas reales en local y en el despliegue.** Se han ejecutado las pruebas correspondientes sobre la versión final integrada y se han recorrido los flujos esenciales en el entorno desplegado. No basta con que compile, pase el linter, funcionen los mocks o responda un endpoint de salud. Los errores encontrados se corrigen y los flujos afectados se vuelven a probar.
  - [x] [local real] typecheck, lint y test:unit en verde sobre el HEAD actual con entorno reproducible.
  - [ ] Gate completo y cobertura del SHA final; flujos esenciales recorridos en producción; ciclo corregir → re-probar.

- [ ] **9. Despliegue final y documentación completos.** Los cambios están integrados y desplegados; la versión publicada corresponde al código verificado; la documentación describe todas las funciones reales y los procedimientos de operación y recuperación; y no quedan pendientes críticos ocultos detrás de un «se hará después».
  - [ ] Integrado en `dev`/`main`, desplegado, versión publicada = código verificado.
  - [ ] Guía y operación V4 documentadas en todas las áreas de §10, con los procedimientos de operación y recuperación, sin rutas privadas ni pendientes críticos.

Al finalizar, entrega un informe verificable (`docs/v4-informe-final.md`) con la versión o commit desplegado, los entornos comprobados, la ubicación final de los agentes migrados, el resultado de las pruebas y las evidencias relevantes. Distingue claramente entre lo implementado, lo probado en local y lo verificado en el despliegue.

**No declares una prueba aprobada si no la ejecutaste. No declares una integración funcional si solo la simulaste. No declares terminada la V4 si siguen fallando flujos esenciales.** Si queda algún bloqueo, informa qué falta, qué impacto tiene y qué evidencia existe, sin presentar esa parte como completada.

## Mejoras incorporadas al alcance

Las validó la pasada Opus; el detalle está en la sección 6 de `ordenes/v4-cierre-objetivo.md`.

- [ ] 1. Higiene de secretos en GitHub antes del merge y sacar del código los identificadores de cuentas del dueño.
- [x] 2. Recibo de gates en el repo ligado al SHA, exigido por `deploy.sh`.
- [x] 3. `deploy.sh` más seguro: comprobar los bind mounts antes del build, escribir los pins solo tras un migrator correcto y exigir un backup de ≤ 2 h si hay migraciones pendientes.
- [x] 4. Ensayo de migración genérico para todo el bundle.
- [x] 5. Siembra del super-admin con un comando idempotente y unificación de los dos CLIs de plataforma.
- [ ] 6. Una sola lectura de cuotas compartida por plano, campus y ficha.
- [ ] 7. Mensajes de error accionables en español y motivo de cada capacidad no disponible.
- [x] 8. Pantalla «Empresa retirada».
- [ ] 9. Validar `harness_definitions` contra los descriptores.
- [x] 10. [local real] Autor real en `git log` de contextos y aplicación en el siguiente turno natural. (177947c1, 919bd20e)
- [x] 11. [local real] Inmutabilidad del historial de contextos. (659099d9, 68ac2f7c)
- [x] 12. Contrato entre los handlers MSW y las rutas reales del gateway.
- [x] 13. [código] Preflight de dependencias nativas del gate. (ba5f301a)
- [x] 14. Reservar los subcomandos del CLI como alias inválidos.
- [x] 15. Inventariar las dependencias de Argos con la VPS antes de moverlo.
- [ ] 16. Retirar lo legacy (`fleet_adoption_probe_*`, `fleet_executor_legacy*`) tras migrar.
