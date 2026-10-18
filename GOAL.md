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
- [x] [prod] Humanizar en V4: migraciones hasta 081 aplicadas, Steven owner + platform_admin y Miguel owner con autoridad efectiva, 14 agentes y 14 arriendos vigentes (5cb9ddcb). (auditoría 17-oct)
- [ ] El dueño y León entran a Praxis y usan sus recursos y agentes del hospital desde Cauce, con los agentes corriendo en servidores locales y sus datos conservados. **18-oct:** Praxis creada en producción con León como dueño (entra y ve solo Praxis: 200/403 comprobado), sus 3 agentes del hospital en borrador con 6 versiones de contexto sembradas. Falta mover los agentes a servidores locales.
- [x] [prod] Un ordenador recién enrolado ejecuta agentes sin administrador: server2 enrolado el 18-oct (`executor_ready:true`, `reachable`, identidad y capacidades vigentes), con Kant y Salva intactos. Arreglos que lo hicieron posible: Caddy abierto a las 9 rutas del canal, imagen verificada en cualquier Docker (8ae3296f) y permisos 0600 con umask 002 (9da590f1).
- [x] [local real] Limitador de registro y claim por IP real: `realip` de nginx tras Caddy y `trustProxy` acotado que falla cerrado, IPv6 por /64 (nginx y gateway reales en pruebas; 4830497d, 5f64c05a). Falta fijar `CAUCE_FRONT_PROXY_CIDR` y `CAUCE_TRUSTED_PROXY_CIDRS` en producción.
- [x] [local real] Guardia adversarial que enumera las 173 rutas `/v3` y WS con dos empresas y huellas de filas (2f1080c8): encontró 2 fugas reales (existencia de hosts y poda global de cuotas) y 3 contratos 400/409, en corrección.
- ~~Guardia adversarial verde sin excepciones como matriz~~ — retirado por sobreingeniería (17-oct); se conserva la comprobación práctica de que una empresa no lee ni opera recursos de otra (QA en producción 17-oct: sin fugas).
- [x] [prod] Membresías simplificadas: 081 aplicada en producción, sin columna `role` y con el rol derivado de `console_users` (bc0955d4, c49e6a1e; down incluido). (auditoría 17-oct)

## 2. Credenciales y cuotas por agente

Espacio para administrar credenciales y cuentas de proveedores, con aislamiento y sin exponer secretos. La cuota se consulta en el ordenador donde corre el agente, según su harness, y se muestra en la web con saldo, ventanas y reinicios reales. **Varias cuentas compartidas entre agentes son válidas y no un error.** Estado y hora de actualización siempre visibles; sin valores inventados.

- [x] [local real] CRUD de cuentas con CAS y aislamiento entre empresas; la proyección pública no expone credenciales; la identidad remota se guarda como hash.
- [x] [código] Recetas de cuota por harness (claude, codex, grok) sobre el executor y la terminal remota existentes.
- [x] [código] La ficha del agente muestra ventanas, % disponible, reinicio y fecha de la cuenta vinculada.
- [x] [código] Solo se muestran las ventanas que informa cada proveedor (Claude 5 h/7 d, Codex por duración y modelo, Grok por periodo).
- [x] [local real] Cuenta compartida con aviso «Consumo compartido por N agentes», sin saldos independientes; estados ok/antiguo/desconocido/error; un 429 no se convierte en agotamiento.
- [ ] El dueño consulta desde la ficha de un agente la cuota real de la cuenta que usa. Hay 26 bindings en 11 de 14 agentes, pero los 14 `primary_account_id` están vacíos y el lector sale `unsupported` sin identidad de host (1132ca8a, 5e27731c). (en curso: codex-3)
- [x] [local real] Compartir cuenta ya no es error: el guardián y `cred-guard.py` lo anotan como nota informativa y solo escalan fallos reales; `shared` se calcula con todas las asignaciones de la empresa antes del filtro por tenant (PG; 51c9fd37, 6e05b7d8, c25cc0e6).
- [x] [código] Motivo de cada fallo con seis códigos cerrados de lector a consola, con su acción en español; «Pendiente de autenticación» en cuentas recién creadas (de037ec7, 365d9faf, 6a6ed3ea, 7fc7d7b5).
- [x] Lectores para openclaw y muse, o «sin lector» explícito.
- ~~Contraste con `coutas` y auditoría de logs como entrega aparte~~ — retirado (17-oct): el contraste se hace al aceptar la cuota real del agente y de «Mis cuotas»; los logs revisados no mostraron secretos (2.742 líneas del gateway).

## 3. Espacio «Mis cuotas»

Registrar y consultar cuentas sin agente, instanciar un entorno Docker aislado con el CLI del proveedor y una terminal restringida a autenticar, consultar y mantener; actualizar el CLI y administrar el ciclo de vida desde la interfaz; vista gráfica con tarjetas fijadas, distinta de la vista por agente; consultar mis cuotas desde Cauce sin abrir una terminal.

- [x] [local real] Cuentas sin agente: alta, edición y borrado con pines por persona y empresa que persisten en otro navegador.
- [x] [código] Entorno endurecido (`--read-only`, `cap-drop ALL`, `no-new-privileges`, límites), operaciones tipadas sin shell, login con comando fijo del descriptor y PTY acotado.
- [x] [local real] Cola durable con CAS y fencing para create/authenticate/query/update_cli/delete.
- [x] [prod] Un ordenador de la empresa ofrece el ejecutor de cuotas con la imagen fijada: server2, desde el 18-oct (713d5456), anuncia entornos para Claude, Codex, Grok, Muse y agy (crear, autenticar, consultar, actualizar el CLI y eliminar).
- [ ] El dueño crea un entorno, conecta su cuenta, consulta sus cuotas, actualiza el CLI y elimina el entorno desde «Mis cuotas»; al eliminarlo desaparecen el contenedor y el volumen. La UI y el runtime existen; falta el host de la línea anterior. **18-oct [prod]:** QA qr8 con fedora: crear entorno levanta el contenedor, «Iniciar sesión» llega a la pantalla de login de Codex, cancelar lo deja limpio y eliminar deja 0 contenedores y 0 volúmenes. Falta solo el login con una cuenta real del dueño (y luego consultar y actualizar el CLI), que hace el dueño desde server2.
- [x] [código] **Refresco de token restaurado** solo en entornos de «Mis cuotas» con sesión propia (flag explícito, nunca en contenedores de agentes), con candado, relectura y escritura atómica 0600 (25a27a83, 365d9faf, 425cd569). Falta el recibo real de un entorno autenticado hace >9 h.
- [x] [código] Habilitar Grok (paquete e identidad) y dejar de ofrecer proveedores sin ejecutor (gemini).
- [x] [local real] Datos frescos sin pulsar botones (consulta al abrir la vista si la captura tiene >10 min). (Decisión del dueño, 13-oct: la prueba de uso de 24 h no es requisito; el dueño usa la plataforma durante la semana y reporta.)

## 4. Oficina interactiva y configurable

La oficina refleja los recursos reales de cada empresa, permite entrar al detalle de cada agente (información, estado, contextos y cuotas), muestra el **«cansancio»** distinguiendo disponible, cerca de agotarse, sin disponibilidad, sin datos y error, y es editable sin distribución fija; los cambios persisten tras recargar, iniciar sesión de nuevo o usar otro navegador.

- [x] [código] Plano y campus derivan salas y agentes de la topología, sin agentes fijos en el código.
- [x] [código] El detalle del agente abre su estado, cola, cuotas y «Perfil y contexto» con historial, diferencias y restauración.
- [x] [local real] El cansancio distingue sin datos, error, antiguo, agotado, cansado (<25 %), pausa y «varía por modelo», en plano, campus y ficha.
- [x] [local real] Editor de salas y partes con validación y CAS; el plano persiste tras recargar y en un segundo navegador.
- [x] [local real] La topología y el plano usan la empresa activa: tras cambiar de empresa solo se ven sus salas y guardar el plano da 200 (PG; 022e0ee6, e3c63b0d).
- [x] [código] El campus ordena sus edificios por la posición guardada en el plano y muestra «Leyendo cuotas…» al cargar (b86f7443, 42ac20fa).
- [x] [prod] El dueño ve en la oficina el cansancio de cada agente calculado con las cuotas reales de su cuenta: los 14 agentes de Humanizar vinculados a sus cuentas reales (18-oct) y el cansancio comprobado con el snapshot de producción frente a `cuotas --json` (6cb941fa).

## 5. Migración de agentes a servidores locales

Mueve a **Gaia, Hegel, Hades y Argos** a servidores de la red local para liberar la VPS principal. **Kant** conoce la infraestructura: pregúntale por Cauce. Mide RAM y disco, distribuye según capacidad, migra configuración, contextos, datos y espacios sin trasladar el desorden, verifica credenciales, permisos y conexiones, no borres el origen sin verificación y copia recuperable, libera los recursos y compara la VPS antes y después.

**Ampliación del dueño (12-oct-2026):** Cauce se retira también de la máquina del hospital. **Los agentes de Praxis** (muse frontend/backend, openclaw operator y sales, crm) se mueven a los servidores locales y esa VPS se apagará; lo publicado del hospital irá a otra infraestructura más barata, por decidir. La VPS principal sigue alojando Cauce central.

- [x] [local real] Relocalización entre hosts con slices selladas y coordinador (PG).
- [x] [prod] Precedente de agente fuera de la VPS: Salva corre en server2 (`agents.host_id=server2`, `ops/flota-fisica.json`). (auditoría 17-oct)
- [x] [local real] Medición de los cuatro espacios sin leer contenido, recibo `.delegados/v4/recibos/vps-antes-20261012.json` (RSS: Gaia 305 MB, Hades 224 MB, Argos 1,48 GB, Hegel 151 MB). Las cifras antiguas no tenían recibo.
- [x] [código] Drivers de flota por descriptor para Gaia (openclaw+Anthropic), Hades (grok) y Hegel (muse): `fleet_module` en sus descriptores y `ops/cli/fleet_provider_*.py`. El canario real es la línea de Gaia.
- [ ] Los cuatro agentes (Gaia 1 GiB, Hades 1 GiB, Argos 3 GiB, Hegel 2 GiB) tienen su sitio decidido en server2 con server1 de reserva (`docs/v4-migracion-plan.md` §5); falta confirmarlo con la medición del día del corte.
- [ ] El dueño ve en cada agente su cuenta, modelo y pagador reales (bindings registrados en producción sin cambiar de cuenta) y la sesión del proveedor está en server2 en privado (0600, sin Git ni logs). Los bindings leídos están en `docs/v4-migracion-plan.md` §2.
- [ ] Antes de mover cada agente queda una copia recuperable de su espacio y se ensaya la vuelta atrás. El mecanismo existe (`v4-medicion-migracion.sh copiar|comprobar-copia|restaurar`); falta usarlo con un agente real.
- [ ] Gaia, después Hades, Argos y Hegel, responden por Cauce desde server2 con su terminal (CLI y web), su cuota, su contexto aplicado y el host visible en la UI. El dueño edita el contexto y detiene o arranca el agente en el host nuevo. Hegel tiene espacio propio sin tocar `ws-humanizar`. Requiere server2 enrolado.
- [ ] Medición de la VPS antes y después de migrar con `ops/scripts/v4-medicion-migracion.sh medir|comparar` (el «antes» del 12-oct está caducado: se rehace el día del corte). La liberación del origen 7 días después la hace el dueño.
- [ ] León usa Praxis en V4: la empresa existe en producción con sus agentes y servicios del hospital, que corren en servidores locales y responden por Cauce; luego se retira Cauce del hospital. El port del código ya está hecho; falta crear la empresa y mover los agentes.

## 6. Gestión de recursos, Docker y CLI de Cauce

CRUD completo y real de todas las entidades desde la interfaz, con efecto en el entorno real; orquestador de espacios Docker (elegir ordenador, instanciar, administrar y eliminar); el CLI `cauce` conserva sus capacidades y facilita crear espacios; copias descargables del contenido persistente con recuperación documentada; estados reales pendiente / en ejecución / completada / fallida; reintentos sin duplicados ni huérfanos.

- [x] [local real] CRUD en Chromium+PG de clientes (= tenants), salas, membresías, registro de agente, empresas, cuentas, plano e invitaciones.
- [x] [local real] Executor contra Docker real local: create, prepare, stop y purge.
- [x] [código] Operaciones de flota con preview, enqueue, CAS y fencing; retiro reversible y purga; el servidor rechaza pasos sin evidencia.
- [x] [local real] CLI: despacho previo intacto más `platform`, `hosts`, `context`, `spaces`.
- [x] [local real] Copias con sha256, identidad y omisiones (PG 16/16; restauración CLI de >96 MiB).
- [ ] El dueño elige su ordenador en la web (también server2), crea y actualiza un agente con su configuración y contexto efectivos, lo detiene, lo retira y lo purga, y el agente responde desde ese host. Hoy la capacidad publicada solo ofrece `server`; falta activar server2 como destino. (auditoría 17-oct)
- [x] [código] Copias de hasta 1 GiB descargadas por enlace sin buffering con su SHA-256 visible; el filtro omite solo credenciales reales (archivos, directorios y tokens por contenido) e incluye el código con `auth|session|token` en el nombre; `.git` se omite con motivo `vcs_metadata` en el manifiesto (feda39de, 4a3a5a00, 08ea438f, 22b98c0d, 9f0a61d3).
- [x] El dueño ve los nombres del contenedor y los volúmenes antes de purgar, confirma con el alias y recibe el resultado físico; un create fallido se puede reanudar o cancelar limpiando sus recursos. El código existe (AgentLifecyclePanel, fleet_executor_steps); falta recorrerlo en producción con un canario. Sin barrido de huérfanos como paso del gate. **18-oct [prod]:** QA qk1+qk3 sobre b0211f01 en kratos: la purga lista contenedor y volúmenes y confirma con el alias; el resultado físico queda en «Operaciones recientes» tras recargar; el create sin sesión se reanuda o se cancela con compensación que borra contenedor y volúmenes; la baja del ordenador con copias pide consentimiento y las borra (409→204).
- [ ] El dueño instala el CLI vigente en su ordenador y en server2, entra con `cauce login`, abre `cauce <alias>` de un agente dinámico y usa `cauce spaces create|list|edit|retire`. El código está (a5f74bcf, 8afaafe2); el CLI instalado en kratos es el antiguo. (en curso: codex-1)
- ~~e2e real, matriz CRUD por máquina y pruebas físicas de interrupción~~ — retirado por sobreingeniería (17-oct). El runbook de recuperación ya existe en `docs/v4-runbook-copias.md` (08f29d7a). Lo que queda como función: el dueño descarga la copia de un espacio y la restaura.

## 7. Sistema extensible de harnesses

Incorporar un harness debe ser una operación clara mediante configuración JSON/YAML interpretada por el sistema (instalar, configurar, autenticar, ejecutar, actualizar, consultar cuota), validada con errores comprensibles y con capacidades en la UI iguales a lo ejecutable; documentado y probado.

- [x] [prod] 8 descriptores JSON + fake2 validados, empaquetados y fijados por digest con parsers cerrados en TS y Python: 9/9 válidos dentro del gateway productivo, digests alterados rechazados, 7 harnesses reales con pins aprobados. (auditoría 17-oct, E2)
- [x] [local real] En «Mis cuotas», las capacidades salen del descriptor aprobado y un descriptor alterado retira la capacidad.
- [x] [código] Los comandos (login, cuota, paquete de update, módulo de flota) pasan al descriptor y salen de `harness_operations.py`. (ccf554d1, 75ddb35d)
- [x] [prod] Un harness nuevo entra con su descriptor y plantilla de runtime, sin lista fija de proveedores (f1985f46, desplegado desde 85c3fc71).
- [ ] Gaia (OpenClaw+Anthropic), Hades (Grok) y Hegel (Muse) corren en server2 con su cuenta, responden por Cauce y conservan terminal y contexto. Los drivers existen (fleet_provider_grok/muse/openclaw); hoy están en `server`.
- [x] [código] Descriptores honestos; errores con campo y motivo; capacidades por acción. (ccf554d1, 27200201)
- [ ] El dueño consulta cuotas y actualiza el CLI de una cuenta Claude/Codex desde «Mis cuotas» en server2 y vuelve a consultar sin perder la sesión. fake2 y su runbook ya existen (1ff5c418, docs/v4-archivos-contextos.md).

## 8. Reorganización de archivos y versionado de contextos con GitHub

Estructura estándar de espacios (contextos/directivas, proyectos, configuración no sensible, datos, registros, temporales), usada de verdad por backend, CLI, contenedores, UI y copias, migrada sin pérdida. Un único repositorio privado compartido (`tenants/<tenant>/agents/<agent>/context/`) con aislamiento, identificadores estables, registro de cada cambio con autor y fecha, todas las vías de edición, estados local / Git / GitHub distinguidos, concurrencia sin pérdidas, historial, diff y restauración desde la UI, aplicación efectiva al agente y sin secretos.

- [x] [código] Layout estándar (`prepareSpaceLayout`, `CAUCE_SPACE_ROOT` derivado y verificado por el executor V4, materialización por turno) y copias con allowlist y exclusión de secretos probada.
- [x] [local real] Aislamiento entre empresas en el repo compartido e **identidad estable** (alias inmutable; nombre y sala editables sin perder historial).
- [x] [local real] **Registro** con contenido, digest, origen, autor y fecha; Git solo con `context/` y `directives/` de texto y escaneo de secretos.
- [x] [local real] Broker Git con CAS y replay; push fallido recuperable; estados separados; concurrencia por agente con CAS; historial, diff y restauración como versión nueva (backend).
- [x] [local real] Transporte a GitHub privado `stevenvo780/cauce-agent-contexts` probado con contenido sintético.
- [ ] El dueño trabaja y descarga una copia completa de cada espacio migrado, con proyectos y contextos conservados. El agente responde leyendo desde la ruta nueva y queda una copia recuperable del origen. El supervisor ya exporta `CAUCE_SPACE_ROOT`/`TMPDIR` (93f193fc).
- [x] [prod] El dueño consulta en GitHub el historial inicial de los 14 agentes reales de Humanizar con sus documentos actuales: siembra del 18-oct (seeded=14) y la cola de contexto quedó en `synced` (17/17). Los `TOOLS.md` con secretos quedaron fuera de Git; Praxis, cuando exista. (a7407e52, 09f7beac, 015ffd01)
- [x] [local real] **Versionar las ediciones hechas en el espacio del agente**: hoy no se registran y además bloquean sus turnos. (0e186764, adc0bf9d, 341d4dbc, 99683b04)
- [x] [local real + prod] El dueño cambia una directiva y Claude y Codex la usan en su siguiente turno con la versión aplicada visible: recorrido real con `codex exec` y `claude --print` (versión 1 → 2, documento nativo regenerado); arreglo 00e3784f desplegado desde 5af22b9e.
- [x] [local real + prod] El dueño guarda cambios de varios agentes y recupera una sincronización fallida: recorrido real con un remoto caído y reintento desde la ficha (4 versiones y 4 commits con autor); desplegado en 015ffd01. Historial real de Humanizar en GitHub, 17/17 synced.

## 9. Auditoría, diagnóstico y eliminación de código innecesario

Revisar los mecanismos por su uso real, eliminar lo que no aporta y quedarse con un diagnóstico pequeño y efectivo que relacione cada operación con empresa, agente, ordenador y componente, reconstruya cadenas de fallo e incluya infraestructura y sincronización de contextos, sin capas de apariencia.

- [x] [código] Ids de cadena existentes de extremo a extremo (`trace_id` de mensajes, sesión de terminal, `operation_id` de flota) y `audit_events` con empresa y actor.
- [x] Inventario de uso real medido en producción en solo lectura, con productores, lectores y decisión por mecanismo (`docs/v4-diagnostico.md`; ec1dff01, 2a64d09f).
- [x] [local real] Poda: cinco guardias de credenciales solapadas, doble escritura JSONL+PG de decisiones y lector V3 de contextos, con regresión en verde (hoy V4 no borró ni un archivo).
- [x] [local real] Lectura de auditoría por empresa con filtros en servidor; consulta de cadena por id; causas saneadas de fallos de sync; ensayo de cuatro rupturas reales localizadas solo con los registros.

## 10. UI/UX, pruebas y documentación

Vistas completas y cuidadas, CRUD probado de punta a punta con efectos reales, pruebas unitarias, de integración y e2e reales (no solo mocks), fallos de SSH, CLI, reinicios y conflictos, recursos de prueba identificables y limpiados, y documentación de todo lo real.

- [x] [local real] Matriz `pnpm test` 12/12 sobre `533d245e`; SSH real (sshd efímero), Docker real, PTY real y GitHub sintético real.
- ~~17 e2e con navegador y recorrido V4 de 12 pasos como entregable~~ — retirado por sobreingeniería (17-oct); el recorrido existe en `tests/e2e/v4-console-real-browser.test.ts` y la QA se hace usando el producto.
- [x] El dueño completa las acciones principales de su empresa desde el móvil y el escritorio, entiende si están en curso o fallaron, conserva el borrador ante un conflicto y puede reintentar. Se comprueba con QA de agentes en producción (17-oct: Mis cuotas, ordenadores, mensajes, registro, oficina). **18-oct [prod]:** QA qm1 sobre 5f4494f7 en 390×844 y 1440×900: registro, sala, persona, agente, configuración, perfil, fichero y Mis cuotas con estado en curso y resultado; conflictos reales con dos pestañas en plano, fichero, perfil y administradores conservan el borrador y «Releer y reintentar» funciona; sin desborde en móvil. Quedan dos detalles cosméticos (aviso doble del plano, «Preparar» encima de «sin ordenador»).
- [x] [local real] Versionar el e2e V4 en `tests/e2e`; rutas V4 en `qa:layout`; pruebas de fallo con procesos reales; tabla de pruebas reales por categoría.
- [x] [código] `docs/v4-guia.md` y la subsección «Desplegar V4» de `docs/operacion.md` documentan el comportamiento real entregado, incluidos los procedimientos de operación y recuperación, en estas áreas: uso desde la interfaz, administración, CLI, arquitectura multitenant, registro de ordenadores, gestión de agentes, harnesses, credenciales, cuotas, oficina, estructura de archivos, integración con GitHub, migraciones, copias de seguridad, restauración, despliegue y diagnóstico. Además, corregir los docs desfasados y quitar las 57 rutas privadas.

## 11. Ejecución, despliegue y máxima paralelización

Máxima paralelización efectiva con revisión independiente; entorno local real; ciclos **implementar → probar en local → desplegar → probar lo desplegado → corregir → volver a desplegar y verificar**; copias y reversión antes de tocar datos. El despliegue forma parte de la tarea y está autorizado dentro de los entornos de Cauce y los accesos disponibles, respetando su configuración de acceso y privacidad: no se para en «listo para desplegar» ni se evita desplegar por cautela genérica. La paralelización acelera la entrega sin saturar los servidores, sin agotar los recursos que necesitan los agentes operativos (la VPS ya tiene la swap llena; server2 aloja a Kant, Salva y los `cuota-cli`) y sin comprometer la integridad de los datos. La revisión independiente, de un revisor distinto del autor, cubre seguridad, regresiones, casos límite y experiencia de usuario.

- ~~Equipo de modelos y 4 carriles tmux~~ — retirado: es organización del trabajo, no función del producto (17-oct).
- [x] [local real] Backup predeploy del 12-oct aprobado (ya caducado para la ventana real); restore aislado de producción con 052–064 y datos intactos.
- [x] Contraseñas de fixture sustituidas por placeholders construidos en ejecución (41a2fda6) e ids y correos del dueño fuera de `ops/cuotas` (75ddb35d). **Dueño:** marcar los falsos positivos históricos en GitGuardian.
- ~~Gate completo por candidato con cobertura ≥ 94,49 %~~ — retirado por sobreingeniería (decisión del dueño 17-oct): el gate de despliegue es typecheck + lint + empaquetado (698e33a6) y la verificación es funcional.
- [x] [local real] Ensayo 052–065 sobre el dump de producción del 12-oct: 307 279 filas intactas, transacción de 663 ms, contención que falla sin aplicar nada y reversión real 065→051→065 con los `down` corregidos (4924052c, b976df33).
- [x] [código] Merge a `dev` y fast-forward de `main`.
- [x] [prod] Despliegues continuos con la versión publicada igual al código comprobado: 11 despliegues el 17–18 oct con recibo de gates, backup previo cuando hubo migración y smoke verde (`deploy/HISTORIAL.md`).

## Trabajo a portar de ramas antiguas

Verificado por contenido (Haiku/Sonnet + revisión Opus 5.5): trabajo valioso que no está en V4. Se porta a `claude/v4-cierre` con prueba focal, y la rama fuente se borra al terminar.

- [x] [local real] (P0) **Hospital (Praxis), supervisión y Muse** (98696901, 91e09ba6; aislamiento del backend en bf020517): de `origin/socrates/hospital-supervision-1699` (lo que corre hoy en el hospital), `ops/instances/hospital/muse-cli-backend.py` + test, el plugin `openclaw-muse-native/` + test y `packages/adapter-sdk/src/sdk/engine/conversation-status.ts` + test. No se porta el `safe.directory` de `7530677d`, porque ya está superado por `command_identity`.
- [x] [local real] (P0) **Hospital, revisión QA y continuidad** (49b34d1a, a7f544eb, 8478d526, 40e6f520, f50c8014, 8fcd3280, d403c98f, 8eb47a82): de `origin/kant/rc2-hospital-praxis-20261007`, los commits `1eeca7d9`, `ef4e1fb0`, `caac19b6`, `bc4c60de` y `9cff3b73` entran sin conflictos; `6e3bc3ff` choca en `tests/unit`. Incluye un arreglo del store que V4 no tiene: rechazar con `no_route` un publish human-mcp hacia un consumidor vivo sin la capacidad.
- [x] [código] (P1) **Renovación OAuth** (`b4cd9265`, PR #149; portada en 92112fc8): recuperación del refresh, consentimiento más claro y corrección de `ui_locales` → `invalid_request`. Las otras cuatro variantes eran copias.
- [x] [código] (P1) **Consola** (f088e262): reintentar un adjunto repite la acción que falló. Patch `08c69433` en `portar/consola-reintento-adjuntos/`; hay que ajustar `clearResource` y espiar `HTMLAnchorElement.click` en `MessageAttachments.test.tsx`.
- ~~(P1) Hospital, perfil de proyecto~~ — retirado: el perfil portado (65408377) no tiene consumidor; la supervisión actual de Praxis sigue sin él (17-oct).
- [x] (P2) **Registros de Cronos** (836c6eec, e603d474): 6 filas de `deploy/HISTORIAL.md` y el runbook del buzón (PRs #130 y #134), ordenados por fecha.
- ~~(P2) Pruebas y documentos V3.5 sin commitear~~ — retirado: ya están en 4c2cc25e y 93dcc8de; no es requisito de cierre (17-oct).

## 12. Criterios obligatorios para dar por terminada la tarea

**La V4 solo puede considerarse terminada cuando se cumplan y verifiquen los siguientes criterios.** Ninguno está cumplido entero todavía; dentro de cada uno se marcan las cláusulas ya acreditadas.

- [ ] **1. Multiempresa operativa y aislada.** Humanizar y Praxis funcionan con sus recursos reales. Un usuario nuevo puede registrarse, crear su empresa y utilizarla. Las pruebas confirman que no puede acceder a datos ni ejecutar operaciones de otra empresa, tampoco manipulando solicitudes fuera de la interfaz.
  - [x] [local real] Un usuario nuevo se registra, crea su empresa y entra como owner.
  - [x] [local real] Aislamiento por familias de rutas y en BD.
  - [ ] Humanizar y Praxis con sus recursos reales.
  - [x] [prod] Registro usable en producción: alta atómica de empresa por la web, limitador por IP real tras el proxy; 8 empresas `zz-canary-*` creadas por QA el 17-oct. (auditoría 17-oct)
  - [x] [local real] Solicitudes manipuladas cubiertas: la guardia enumera las rutas `/v3` sin excepciones (0583c45b, 294 casos y 0 fallos). ~~probadas contra el despliegue~~ retirado (17-oct).

- [ ] **2. CRUD completo y real.** Se han probado creación, consulta, edición y eliminación de todas las entidades administrables, tanto desde la interfaz como en sus efectos persistentes y remotos. No quedan botones ficticios, operaciones incompletas ni recursos huérfanos tras las pruebas.
  - [x] [local real] CRUD con persistencia de empresas, clientes, salas, membresías, registro de agente, cuentas, plano e invitaciones.
  - [x] [local real] Executor contra Docker real local.
  - [ ] Agentes, ordenadores, personas, entornos de cuota y contextos con ciclo real y efectos remotos.
  - [ ] Sin huérfanos ni controles ficticios: la purga nombra el contenedor y los volúmenes, y los campos inertes se declaran en la UI. ~~barrido y matriz que lo demuestren~~ retirado (17-oct).

- [ ] **3. Gestión distribuida funcional.** Se pueden registrar ordenadores e instanciar, administrar y eliminar espacios y agentes en ellos. Gaia, Hegel, Hades y Argos funcionan en servidores locales, conservan su información y se ha comprobado la liberación de recursos en la VPS principal. El CLI `cauce` y las terminales remotas mantienen sus capacidades.
  - [x] [local real] Enrolamiento con identidad firmada y relocalización entre hosts (PG).
  - [x] [local real] El CLI conserva su despacho previo.
  - [ ] Ordenador enrolado que ejecuta agentes sin el administrador; espacios y agentes en un host remoto real.
  - [ ] Gaia, Hegel, Hades y Argos (y los agentes de Praxis) en servidores locales con su información; liberación medida.
  - [ ] Terminal por CLI para la flota dinámica.

- [ ] **4. Cuotas reales desde la web.** Funcionan las cuotas por agente y la sección «Mis cuotas», incluyendo autenticación, consulta, actualización de CLI y administración de sus entornos. Se ha probado que varios agentes pueden compartir una cuenta sin errores ni saldos ficticiamente independientes. Las ventanas y los estados mostrados corresponden a los datos reales disponibles.
  - [x] [local real] «Mis cuotas»: cuentas sin agente y tarjetas fijadas con persistencia.
  - [x] [local real] Estados explícitos y cuenta compartida modelada sin saldos independientes.
  - [ ] El dueño crea, autentica, consulta, actualiza y elimina un entorno de cuotas real desde «Mis cuotas» (hoy 0 entornos en producción; depende de un ordenador con ejecutor).
  - [ ] Cuotas por agente según harness; cuenta compartida por dos agentes reales; ventanas contrastadas; verificado en producción. **18-oct [prod]:** QA qc1: la barra y las cuentas de la ficha de los 14 agentes coinciden con el CLI `cuotas` a 0 puntos, con reinicios iguales; tres cuentas compartidas muestran el mismo saldo en todos sus agentes. Falta el lector «según harness» dentro del contenedor: dice «Todavía no hay una medición persistida» en los 14 (8 sin ubicación V4), y se cierra con los traslados.

- [ ] **5. Oficina y harnesses operativos.** La oficina responde a la creación, edición, asignación y eliminación de salas y agentes; su configuración persiste; y el detalle de cada agente muestra correctamente sus cuotas y estado visual. El mecanismo de configuración de harnesses se ha probado con operaciones reales y no depende de cambios dispersos para cada integración.
  - [x] [local real] El plano persiste tras recargar y en otro navegador.
  - [x] [código] Salas y agentes dinámicos y cansancio con estados distintos.
  - [x] [prod] La oficina refleja altas y bajas, el campus sigue el plano y la ficha abre con datos reales: QA en producción qr2 y qr6 (18-oct) sin bloqueos.
  - [x] Harnesses con operaciones reales y alta sin cambios dispersos. **18-oct [prod]:** alta de un harness en 3 archivos (descriptor, bin, entrada de package.json; antes 10) desplegada en 0ab397e1; plantillas reales Claude, Codex, Grok, Muse y OpenClaw (Claude/Grok/Codex) medidas en la imagen firmada y anunciadas por server2 (7 plantillas); los canarios llegan a `awaiting_auth` en kratos y fedora.

- [ ] **6. Archivos ordenados y contextos versionados.** Los espacios utilizan la estructura estándar sin pérdida de datos ni rutas rotas. El repositorio compartido de GitHub contiene las carpetas de los agentes y registra sus cambios. Se han probado la edición desde las vías soportadas, el historial, las diferencias, la restauración, la aplicación efectiva al agente, las escrituras concurrentes y la recuperación después de un fallo de sincronización, sin exponer secretos ni contextos entre empresas.
  - [x] [local real] Concurrencia con CAS sin descartar contenido; guardado, Git y sincronización separados con fallo recuperable; historial, diff y restauración; identidad estable y aislamiento en el repo.
  - [ ] Espacios reales con la estructura estándar; repo con las carpetas reales; edición por todas las vías; aplicación con turno real; recuperación ensayada en producción.

- [x] **7. Copias, recuperación y diagnóstico comprobados.** Se puede descargar una copia del contenido de un espacio y restaurarla en un entorno de prueba. Los fallos relevantes dejan un rastro útil para encontrar su causa. La eliminación de componentes de auditoría innecesarios no ha roto funciones ni suprimido controles necesarios.
  - [x] [local real] Restauración en entorno de prueba con datos sintéticos.
  - [x] El dueño descarga desde la consola la copia de un espacio real y la restaura siguiendo `docs/v4-runbook-copias.md`. **18-oct [prod]:** QA qk1 en producción con kratos como ordenador: dos copias pedidas desde «Perfil y contexto → Backup del espacio», ZIP descargado, SHA-256 igual al recibo y a la pantalla, restauradas y comparadas archivo a archivo; el historial Git ya no puede colar secretos (cp2).
  - [x] [local real] Rastro útil de fallos y poda de auditoría sin romper nada.

- [ ] **8. Pruebas reales en local y en el despliegue.** Se han ejecutado las pruebas correspondientes sobre la versión final integrada y se han recorrido los flujos esenciales en el entorno desplegado. No basta con que compile, pase el linter, funcionen los mocks o responda un endpoint de salud. Los errores encontrados se corrigen y los flujos afectados se vuelven a probar.
  - [x] [prod] typecheck, lint y empaquetado en verde sobre cada SHA publicado, con su recibo (`.delegados/v4/corte.sh`, recibos en `.delegados/v4/recibos/gate/`).
  - [x] [prod] Flujos esenciales recorridos en producción por QA de agentes con el ciclo corregir → volver a probar: registro, personas, cuotas, ordenadores, mensajes, oficina, Ajustes botón por botón, móvil, aislamiento y primer día de un cliente (17–18 oct).

- [ ] **9. Despliegue final y documentación completos.** Los cambios están integrados y desplegados; la versión publicada corresponde al código verificado; la documentación describe todas las funciones reales y los procedimientos de operación y recuperación; y no quedan pendientes críticos ocultos detrás de un «se hará después».
  - [x] [desplegado] Integrado en `dev`/`main`, desplegado, versión publicada = código verificado.
  - [x] [prod] Guía y operación V4 al día (`docs/v4-guia.md`, `docs/operacion.md`), seguidas al pie de la letra contra producción y corregidas (18-oct).

Al finalizar, entrega un informe verificable (`docs/v4-informe-final.md`) con la versión o commit desplegado, los entornos comprobados, la ubicación final de los agentes migrados, el resultado de las pruebas y las evidencias relevantes. Distingue claramente entre lo implementado, lo probado en local y lo verificado en el despliegue.

**No declares una prueba aprobada si no la ejecutaste. No declares una integración funcional si solo la simulaste. No declares terminada la V4 si siguen fallando flujos esenciales.** Si queda algún bloqueo, informa qué falta, qué impacto tiene y qué evidencia existe, sin presentar esa parte como completada.

## Mejoras incorporadas al alcance

Las validó la pasada Opus; el detalle está en la sección 6 de `ordenes/v4-cierre-objetivo.md`.

- [x] 1. Higiene de secretos en GitHub antes del merge y sacar del código los identificadores de cuentas del dueño. **18-oct:** Gitleaks da 0 hallazgos sobre `git archive HEAD` (b743118b, allowlist por ruta exacta de fixtures); historia sin secretos de producción que rotar; las claves de cuenta del dueño ya no están en el código (solo `zz-canary-*` en ejemplos; quedan dominios públicos de sus webs, que no son secretos).
- [x] 2. Recibo de gates en el repo ligado al SHA, exigido por `deploy.sh`.
- [x] 3. `deploy.sh` más seguro: comprobar los bind mounts antes del build, escribir los pins solo tras un migrator correcto y exigir un backup de ≤ 2 h si hay migraciones pendientes.
- [x] 4. Ensayo de migración genérico para todo el bundle.
- [x] 5. Siembra del super-admin con un comando idempotente y unificación de los dos CLIs de plataforma.
- [x] 6. Una sola lectura de cuotas compartida por plano, campus y ficha (4c44360a, en producción).
- [x] 7. Mensajes de error accionables en español y motivo de cada capacidad no disponible (33f37937; QA 17-oct tradujo los restantes, bd7c012f).
- [x] 8. Pantalla «Empresa retirada».
- ~~9. Validar `harness_definitions` contra los descriptores~~ — retirado: la BD y los descriptores coinciden y la UI ya usa el descriptor aprobado (17-oct).
- [x] 10. [local real + prod] Un agente aplica la versión nueva de su contexto en su siguiente turno natural (00e3784f; ver §8). El autor real en `git log` ya está hecho (177947c1, 919bd20e).
- [x] 11. [local real] Inmutabilidad del historial de contextos. (659099d9, 68ac2f7c)
- [x] 12. Contrato entre los handlers MSW y las rutas reales del gateway.
- [x] 13. [código] Preflight de dependencias nativas del gate. (ba5f301a)
- [x] 14. Reservar los subcomandos del CLI como alias inválidos.
- [x] 15. Inventariar las dependencias de Argos con la VPS antes de moverlo.
- [ ] 16. Retirar lo legacy (`fleet_adoption_probe_*`, `fleet_executor_legacy*`) tras migrar.
