# Objetivo: cerrar Cauce V4 (relevo de GPT a Claude)

Este archivo es el **goal de ejecución** para terminar Cauce V4. La especificación vinculante sigue siendo el texto literal del dueño en [`docs/v4-objetivo-del-dueno.md`](../docs/v4-objetivo-del-dueno.md): aquí no se retira ningún requisito ni ningún criterio de aceptación. Este documento añade tres cosas: el **estado real verificado** de cada requisito, el **trabajo que falta** con su criterio de comprobación y las **mejoras no contempladas** que se incorporan al alcance.

Origen del estado: auditoría del 12-oct-2026 sobre la rama `codex/v4-complete` (`56c0c016`) con 34 agentes Haiku (mapeo de código y evidencia), 15 Sonnet (conciliación, juez de mejoras y crítico) y una **pasada final de 8 revisores Opus 5.5** que verificó cada afirmación contra el código y los recibos. Donde Opus corrigió a Sonnet, prevalece Opus.

## 0. Leyenda

- `[x]` cumplido, con el nivel de evidencia entre corchetes: **[código]** existe y está cableado; **[local real]** probado en local con componentes reales (PostgreSQL, Docker, Git, filesystem, Chromium sin interceptores); **[desplegado]** verificado en producción.
- `[ ]` pendiente. Prioridad: **P0** bloquea un criterio de aceptación; **P1** necesario para cerrar el requisito; **P2** deseable.
- **[DUEÑO]** necesita una acción o decisión que solo el dueño puede dar (ver §3).
- `✓` después de una tarea: cómo se comprueba que está hecha.
- `R` = esta rama (`claude/v4-cierre`, checkout `/datos/workspaces/personal/cauce-v4-claude`). `S` = estado privado de la ejecución de GPT (`/home/stev/.local/state/cauce-v3/v4-complete-20261011`); se usa solo como fuente histórica, nunca como evidencia de cierre.

## 1. Punto de partida verificado

| Aspecto | Estado al 12-oct-2026 |
|---|---|
| Código V4 | `codex/v4-complete` = `56c0c016`, publicado en origin. Mi rama `claude/v4-cierre` parte de ese commit. `56c0c016` = `533d245e` + tests de oficina + devDependency `@napi-rs/canvas` + docs; sin código de producción nuevo. |
| Integración | PR #151 abierto contra `dev` (726 archivos, +36 160/−3 034), mergeable. **GitGuardian en rojo: 6 secretos** en los 107 commits. `origin/main` = `origin/dev` = `94959fb0`. |
| Gates del HEAD | En `R`, con `pnpm install --frozen-lockfile` y venv `~/.venvs/cauce-qa` (jsonschema, pyyaml, ruff, shellcheck): **typecheck 0, lint 0, test:unit 0** (consola 286 archivos / 2 966 pruebas; raíz 154 / 2 325). `pnpm test` completo (12 suites) **nunca terminó** sobre `56c0c016` (8/12 antes de detenerse). Sobre `533d245e`: matriz 12/12 PASS; release falló en **cobertura de consola 87,16 % < piso 94,69 %**. |
| Producción | VPS `167.114.118.213` corre **V3**: runtime `34cd5ea0`, esquema 051. **0 % de V4 desplegado.** |
| VPS (12-oct 18:55 UTC) | 62 GiB RAM (30 disponibles), **swap 9/9 GiB llena**, disco 83 % (82 GB libres), load 5–8 en 16 núcleos. `ws-humanizar` 13,6 GiB y 116 % CPU. |
| Agentes a migrar | Gaia → `agv2-miguel-finca-oc` (openclaw, `anthropic/claude-opus-5`); Hades → `agv2-steven-hades-oc` (grok); Hegel → dentro de `ws-humanizar` (muse, compartido con Atlas y Kratos); Argos → dentro de `ctrl-infra` (openclaw, OpenAI). Ninguno migrado. Bindings de cuenta/modelo en V4: NULL. |
| Servidores locales | server1 `192.168.78.232`: 23 GB RAM (~11,8 disp.), 261 GB libres, **sin Docker** (LXD). server2 `192.168.78.211`: 23 GB RAM (~11,7 disp.), ~143 GiB libres, Docker; ya aloja `ws-isa`/Salva, Minecraft y los contenedores `cuota-cli` (`cuota-claude-1`, `cuota-claude-3`, `cuota-codex-b2b`, `cuota-grok-1`). server3: no responde en `.126`; visto en `.125` con huella SSH sin verificar. Kant (operador) vive en server2. |
| Empresas | Humanizar = Steven + Miguel (producción actual). Praxis = León, instancia V3 aparte por `ssh hospital` (tenant `Hospital`, esquema 043), aún no importada. Solo Steven es super-admin de plataforma. |
| Avance real | ~**35 %** frente a los criterios: código ~70 %, probado en local con componentes reales ~35 %, desplegado 0 %. (GPT declaró 55 %, que mide esfuerzo, no aceptación.) |

## 2. Reglas de ejecución

Lecciones de la ejecución anterior convertidas en reglas:

1. **Nada de maquinaria nueva de despliegue.** No se crean orquestadores, observadores, controladores ni "holds" (GPT dejó 45 artefactos así en `S`, ninguno en el repo). Se despliega con lo existente: `deploy/deploy.sh` (con `CAUCE_DEPLOY_FLEET_OVERLAY=1`), `host-backup.sh`, `build-adapter-release.sh` y `fleet-controller-upgrade.py`, según `docs/operacion.md` §1 y `docs/v3.5-controlador-despliegue.md`.
2. **Un gate completo por candidato, y con verde se despliega el mismo día.** Durante el desarrollo, pruebas focales. Nada de re-ejecutar matrices completas sobre SHA intermedios.
3. **Recibos en el repo o en un directorio durable**, con SHA, comando, exit y log. Nunca `/tmp`. Los drivers de prueba (p. ej. el recorrido Chromium de `S/ui-real/`) se versionan en `tests/`.
4. **Un único informe de estado** (`docs/v4-informe-final.md`) actualizado en cada ciclo, con los tres niveles separados. `aceptacion.json` de GPT queda como histórico.
5. **Cada componente nuevo reemplaza algo o justifica por qué no** (Regla 0 de `AGENTS.md` y §1.4/§9 de la especificación). V4 añadió 286 archivos y no borró ninguno.
6. **Antes de preguntar al dueño, comprobar la especificación y los hechos.** El despliegue está autorizado (§11). Las preguntas imprescindibles van en un solo lote (§3) y, mientras tanto, se avanza con todo lo que no depende de ellas.
7. **Revisor ≠ autor.** Cada cambio importante lo revisa otro agente; la **revisión final la hace Opus 5.5**. Los informes del propio autor no son evidencia.
8. **Recorrer los flujos como usuario antes de pulir verificación.** Defectos simples (limitador de registro global, tope de 32 MiB en la consola) se escaparon mientras se perfeccionaban gates.
9. **Seguridad operativa.** No se borra el origen de ningún agente hasta tener en destino nonce, terminal, cuota y contexto verificados y una copia offsite. Recursos de prueba con prefijo `zz-canary-<run>` y limpieza comprobada al final.
10. **Coordinación.** Antes de cada deploy, coordinar con la sesión `claude/consola-rediseno`. Codex solo recibe tareas acotadas (sus paquetes grandes mueren con `stream disconnected`) y Claude cierra. Sin dos escritores por archivo.
11. **Entorno reproducible.** `pnpm install --frozen-lockfile` en cada checkout nuevo y el venv `~/.venvs/cauce-qa` en `PATH` para el gate; un fallo por herramienta ausente no es un fallo de código.

## 3. Preguntas al dueño (lote único)

Todo lo demás lo resuelve la especificación o es una decisión técnica delegada por la §11.

1. **GitGuardian (PR #151, 6 secretos).** Preparo la revisión local con los candidatos; los vistos son URLs `postgres://` con contraseña de fixture en tests (`ops/tests/cauce-plataforma-cli.test.mjs`, `provision-db-roles.test.mjs`, `cauce-plataforma-contenedor.test.mjs`, `ops/scripts/rehearse-v41-clone.sh`, `services/decisiones/test/catalog-scope.test.ts`). ¿Los marcas como falsos positivos en el panel tras sustituirlos por placeholders, o hay alguno real que rotar?
2. **Credenciales en la migración.** ¿Autorizas copiar en privado las sesiones de proveedor actuales de Gaia, Hades, Argos y Hegel a server2 (SSH directo, 0600, sin pasar por copias, Git ni logs)? Alternativa: login por dispositivo de los titulares en la ventana del traslado (Steven para Hades y Argos; Miguel para Gaia y Hegel). Por defecto, cada agente conserva su cuenta actual.
3. **Login real de proveedor desde la web.** Para cerrar el criterio 4 hace falta que apruebes en vivo (~5 min) un login OAuth/device-code en «Mis cuotas». ¿Qué cuentas (propuesta: las de `cuota-claude-1`, `cuota-codex-b2b` y `cuota-grok-1`) y en qué franja?
4. **Praxis.** ¿Correo de León para crear su usuario owner (o prefieres que se registre él)? ¿Confirmas que la V3 del hospital sigue en paralelo hasta que León valide Praxis en V4, y en qué ventana se hace el corte?
5. **Hegel** (con valor por defecto): si no indicas otra cosa, se le pregunta a Hegel por Cauce con qué repos trabaja, se clonan desde GitHub en su espacio nuevo de server2 y `/workspace` de Humanizar no se copia; Atlas y Kratos siguen en la VPS.

## 4. Estado y trabajo por sección

### §1 Multiempresa, registro y aislamiento

**1.1 Todo multitenant; Humanizar y Praxis funcionales** — parcial.
- [x] [código] Esquema multiempresa en migraciones 051–065; **053 bloquea en BD con 33 triggers** las escrituras y referencias entre empresas (sin RLS; la lectura se acota en la aplicación).
- [x] [código] API de empresa (`routes/console/companies.ts`: lista, detalle, alta, PATCH con CAS, retiro con datos conservados) y admins por empresa (`company-admins.ts`); UI `CompaniesPanel` con «Retirar/Restaurar».
- [x] [local real] ~110 pruebas PostgreSQL multiempresa en verde en la matriz `533d245e`; recorrido Chromium+PG: crear empresa con dueño, editar con recarga y retiro que revoca la autoridad.
- [ ] (P0) **Humanizar real en V4**: ensayar 051→065 sobre un dump fresco (extender `ops/scripts/rehearse-v41-clone.sh`, hoy fijo a 052–054), sembrar `platform_admins` = Steven y owners de `humanizar` = Steven + Miguel. ✓ En el clon y luego en producción: 1 platform_admin, owners {Steven, Miguel}, conteos de tenants/rooms/agents/memberships/console_users idénticos antes y después; `GET /v3/auth/session` devuelve `platform_admin` para Steven y `company_owner` para Miguel.
- [ ] (P0) **Praxis real** sin importador nuevo: inventario de solo lectura de la V3 del hospital; Steven crea `praxis` con León de owner (`POST /v3/console/companies`); recursos aplicados con `cauce platform change --company praxis --dry-run` y luego `--apply`, agentes en draft. Primero en el clon. ✓ León entra con `acting_company=praxis` y solo ve Hospital; Miguel recibe 403 en `GET /v3/console/companies/praxis`; la V3 del hospital no cambia.
- [ ] (P0) [DUEÑO] **Corte de Praxis**: enrolar el servidor del hospital, activar sus agentes en V4 con sus cuentas actuales y dejar la V3 sin escritores, con `pg_dump` previo a kratos y Drive. ✓ Cada agente de Praxis online con heartbeat firmado y entrega de ida y vuelta; dump con hash verificado en destino.

**1.2 Registro libre, empresa propia y enrolamiento de ordenadores** — parcial.
- [x] [código] `POST /v3/auth/register` (Zod estricto, scrypt, bodyLimit 8 KiB) y alta atómica `cauce_register_company` (055/063): empresa, tenant hub, sala office, agente owner, membresías y `company_admins`.
- [x] [local real] Registro, login y dueño en Chromium+PG (sobre un árbol intermedio; repetir en el SHA final).
- [x] [local real] Invitación de un solo uso con cancelación, claim Ed25519 y heartbeat firmado (`cauce hosts enroll|heartbeat`, migración 059): 9/9.
- [ ] (P0) **Un ordenador enrolado debe poder ejecutar agentes sin el administrador.** Hoy `cauce hosts enroll` solo da identidad y heartbeat; no existe instalador del executor ni de su política/catálogo firmado. Mínimo: `cauce hosts setup` (o enroll) instala y arranca el executor como servicio de usuario con la política por defecto de la empresa. ✓ En una VM o contenedor limpio con Docker, un usuario recién registrado ejecuta el comando de la consola y, sin el super-admin, el ordenador aparece con `executor_ready=true` y un create de agente termina `succeeded` con el contenedor en `docker ps`.
- [ ] (P1) **Bug: el limitador de registro es global en producción.** Fastify no tiene `trustProxy` y nginx no reenvía la IP real, así que el cupo de 5 intentos/15 min se comparte entre todos los visitantes (lo mismo en el claim de hosts). Propagar la IP real (X-Forwarded-For + `trustProxy` acotado a la red edge) o `limit_req` en nginx. ✓ Test: dos IPs no comparten cupo y el 6.º intento desde la misma IP da 429; un X-Forwarded-For forjado no cambia `request.ip`.
- [ ] (P1) Versionar en `tests/e2e` el recorrido de registro, login, empresa, aislamiento, retiro e invitación (port de `S/ui-real/ui-e2e.mjs` con los fixtures existentes). ✓ `pnpm test:e2e` lo incluye en PASS con mocks=false.

**1.3 Aislamiento en UI, backend, comunicaciones y remoto** — parcial.
- [x] [código] Autoridad de empresa resuelta por solicitud (`consoleHumanAccess().companyAuthority`) en companies, admins, hosts, enrolamiento, personas, operaciones, cuotas y oficina; CLI con empresa explícita.
- [x] [local real] Lecturas aisladas por empresa en PG (`companies-read-isolation-postgres`, `host-authority-postgres`, `terminal-authority-vertical`…); en Chromium, el dueño de B no ve datos de A y recibe 403.
- [ ] (P0) **Prueba adversarial HTTP/WS por enumeración de rutas**: guardia que enumera las rutas `/v3` con `onRoute` y falla si alguna no está en la matriz o en una lista explícita de públicas; por cada ruta con identificadores, la sesión de A usa ids de B y espera 403/404 sin filas modificadas. Incluye `/v3/ws`, ticket de terminal, descarga de copias y `cauce context`. URL base parametrizable. ✓ 0 accesos cruzados en local; añadir una ruta sin cubrir hace fallar la prueba; se repite contra el despliegue.
- [ ] (P1) Aislamiento de efectos remotos reales: desde la empresa A, intentar una operación de flota sobre el ordenador de B. ✓ Rechazo en preview y enqueue, ninguna orden firmada llega al executor de B, fila en `audit_events` y `docker ps` de B sin cambios.

**1.4 Revisar y simplificar membresías** — parcial (sin empezar la simplificación).
- [x] [código] Se conservan los conceptos con función real: `console_users` (identidad, actor de origen, techo de rol), `human_tenant_memberships` (permisos), `company_admins` (owner/admin con protección del último dueño), `platform_admins`.
- [x] [local real] Permisos dentro de una empresa en navegador real (`ui-crud-v35-real-browser`: el lector no escribe) y administración de personas en PG.
- [ ] (P1) `docs/v4-membresias.md`: por cada concepto (`console_users.tenant_id/alias/role/company_id`, `human_tenant_memberships.role/permissions`, `company_admins`, `platform_admins`, membresías de sala, `role_policies`, agente owner), lectores y escritores con `file:line` y decisión (conservar / derivar / eliminar). Aplicar lo eliminable en una migración 066 con su down. Candidatos: doble rol (`console_users.role` vs `human_tenant_memberships.role`) y `company_id` desnormalizado. No tocar `tenant_id`/`alias` sin sustituto. ✓ Cada concepto conservado cita un lector real; cada eliminado tiene up/down probado en PG y desaparece del código; matriz completa en verde.

### §2 Credenciales y cuotas por agente

**2.1 Espacio de credenciales aislado y sin exponer secretos** — parcial.
- [x] [local real] CRUD de cuentas con CAS e idempotencia, escritura acotada a empresa/plataforma; create/edit/delete en Chromium+PG; aislamiento entre empresas.
- [x] [código] La proyección pública no expone `credential_ref` ni `external_account_id`; la credencial vive solo en el volumen propio del entorno; la identidad remota se guarda como SHA-256 (057 con down).
- [ ] (P1) Tras desplegar, auditar logs de gateway y host y `audit_events` de una autenticación real. ✓ 0 coincidencias de `access_token`, `refresh_token`, `sk-ant-`, `eyJ`, `user_code`.
- [ ] (P2) Test de redacción: un secreto sembrado en la salida del lector o del login no llega a `error_code`, `note`, `audit_events` ni stderr.

**2.2 Cuota según el harness, reutilizando terminales y CLI** — parcial.
- [x] [código] Recetas por harness (claude, codex, grok) con verificación del digest del bundle aprobado; reutiliza el executor y la terminal remota existentes; lecturas reales fuera de la web en `S/real-quotas` (5 ok, 1 unknown, 3 error).
- [ ] (P1) **Consultar la cuota en el contenedor donde corre el agente** (requisito literal): acción tipada del executor que resuelve la receta del harness, ejecuta el lector con `docker exec` en su host (HOME del agente, sin refresco) y registra la muestra en la cuenta vinculada. ✓ Recorrido real: la consulta de un agente deja ventanas con el `account_id` de su cuenta y su ficha las muestra con hora.
- [ ] (P1) openclaw, muse, hermes y opencode declaran `quota` sin comando: implementarlo (ver §7) o mostrar «sin lector de cuota para este harness». ✓ Test: todo descriptor con `quota` tiene comando resoluble.

**2.3 Cuota por agente visible en la web** — parcial.
- [x] [código] La ficha del agente (`AgentSheet`, `AgentCard`) muestra ventanas, % disponible, reinicio y fecha de la cuenta vinculada; snapshot con `captured_at`, `received_at`, `reset_at` y estado.
- [ ] (P1) Vincular los agentes reales a la cuenta de su credencial (identidad leída en su contenedor). Hoy la ficha dice «No hay una cuenta vinculada». ✓ `agent_account_bindings` con una fila por agente activo con lector; ninguna ficha dice «sin cuenta».

**2.4 Ventanas reales por proveedor** — parcial (lógica correcta, falta contraste real).
- [x] [código] Claude: solo las ventanas que devuelve el proveedor (los 300/10 080 min son la definición de `five_hour`/`seven_day`, no ventanas inventadas). Codex: ventanas por duración y por límite/modelo. Grok: periodo real. Ventanas por modelo y cuenta separadas (057).
- [ ] (P1) En la web desplegada, comparar las ventanas de una cuenta Claude, una Codex y una Grok con la salida de `coutas` del mismo instante. ✓ Mismas ventanas, % (±1) y reinicio.

**2.5 Cuenta compartida por varios agentes como caso válido** — parcial.
- [x] [local real] Varios agentes por cuenta con `shared` y aviso «Consumo compartido por N agentes» (PG); deduplicación de la misma suscripción por hash de identidad.
- [ ] (P1) **Corregir la lógica que trata compartir como error**: el guardián `ops/guardias/cauce-v3-medico-monitor:778-782` y `cred-guard.py:127-131` escalan «credencial COMPARTIDA». Pasarlo a nota informativa y escalar solo fallos reales (muerta/urgente/401). ✓ Dos contenedores con la misma huella: 0 escalados y 1 nota; una credencial sin refreshToken sigue escalando.
- [ ] (P1) Calcular `shared` con todas las asignaciones de la empresa antes del filtro por tenant (`quota-accounts.ts:43-45,84`). ✓ Test PG: con alcance tenant se ve `shared:true` y el total de agentes sin ver alias ajenos.

**2.6 Estado, hora de actualización y errores explícitos** — parcial.
- [x] [código] Estados ok/stale/unknown/error (stale a los 900 s); `remaining_percent` solo con estado ok; un 429 o error no se convierte en agotamiento; la UI distingue «Sin datos», «Error de consulta» y «Datos antiguos».
- [ ] (P1) **Conservar el motivo del fallo**: `quota_snapshot.py:20` lo reemplaza todo por `quota probe unavailable`. Códigos cerrados (`not_authenticated`, `token_expired`, `forbidden_credential_type`, `rate_limited`, `network`, `provider_error`) con acción en español. ✓ «token caducado» se ve como «Sesión caducada: autenticar de nuevo».
- [ ] (P1) Una cuenta recién registrada aparece «En pausa» (`quota-availability.ts:12`); debe decir «Pendiente de autenticación». ✓ Test de UI.
- [ ] (P2) Mostrar `captured_at` («Medida hace…») además de `received_at`.

### §3 «Mis cuotas»

**3.1 Registrar y consultar cuentas sin agente** — [x] **hecho en local**.
- [x] [local real] Rutas `/v3/console/quota-accounts` con CRUD, CAS y lock; `MyQuotasPage` con alta, edición y borrado; create/pin/reload, edit/CAS y unpin/delete en Chromium+PG; empresa ajena 403.
- [ ] (P1) En la web desplegada: registrar, editar, fijar y eliminar una cuenta sin agente y releer desde otro navegador.

**3.2 Entorno Docker aislado con terminal restringida** — parcial (ningún contenedor creado de verdad).
- [x] [código] `docker create` endurecido (`--read-only`, `--cap-drop ALL` + 6, `no-new-privileges`, pids 128, 512 MiB, usuario 1000, volumen propio); operaciones tipadas sin shell; el comando de login sale del descriptor; PTY con stdin ≤4 096 B.
- [ ] (P0) Construir la imagen de cuotas (`ops/cuotas/Dockerfile`) con versiones de CLI fijadas, los lectores V4 y `codex-refrescar.py`; cargarla en el host y registrar su digest en `policy.quota_environments.image`. ✓ `docker image inspect` = digest de la política.
- [ ] (P0) Enrolar un host con ejecutor de cuotas (server2) con la política y el bundle de descriptores aprobado. ✓ `GET /v3/console/quota-environments` devuelve `capabilities.available=true` para claude y codex.
- [ ] (P0) [DUEÑO] Ciclo real desde la web: crear entorno, autenticar (el dueño aprueba el código), consultar, `update_cli` y eliminar, con Claude y Codex, más prueba de escape (`; sh` e `id` en el PTY no dan shell). ✓ `docker inspect` con ReadonlyRootfs, CapDrop ALL y User 1000; identidad hasheada; ventanas en la tarjeta; tras eliminar, sin contenedor ni volumen.
- [ ] (P1) El formulario ofrece gemini y grok aunque ningún host puede ejecutarlos (`MyQuotasPage.tsx:65,67`): mostrar solo proveedores ejecutables y quitar gemini del esquema. ✓ La API rechaza una cuenta gemini con 400.
- [ ] (P1) **Habilitar Grok** (lo usa el `coutas` diario): añadir su paquete y una identidad verificable (o identidad local «no verificada» sin deduplicar). ✓ `capabilities()` incluye grok; recorrido real con una cuenta Grok.
- [ ] (P2) Endurecer: quitar `SYS_PTRACE`/`DAC_OVERRIDE` si el helper funciona sin ellos y cortar la salida a RFC1918. ✓ El ciclo real pasa y desde el contenedor no se alcanza la LAN ni el gateway interno.

**3.3 Ciclo de vida y actualización del CLI desde la UI** — parcial.
- [x] [local real] create/authenticate/query/update_cli/delete y edición de etiqueta sobre cola durable con CAS y fencing (PG); `remove()` verifica que no queden contenedor ni volumen.
- [ ] (P0) `update_cli` real para claude y codex. ✓ Versión antes/después y una consulta posterior ok en el mismo ciclo de 3.2.
- [ ] (P2) `DELETE` de entornos con `expected_version`/`idempotency_key` en la query string, como las cuentas.

**3.4 Vista gráfica con pines, distinta de la vista por agente** — parcial.
- [x] [local real] Página propia separada de la ficha por agente; pines por persona y empresa con CAS que persisten en otro navegador (Chromium+PG).
- [ ] (P1) Revisión visual a 1 440 y 390 px con ≥2 cuentas reales (una compartida). ✓ Capturas revisadas por un tercero sin desbordes.

**3.5 Consultar las cuotas actuales desde la web sin terminal** — parcial.
- [x] [código] Ruta completa: botón Consultar → cola → executor → `docker exec` → normalización → `recordQuotaSample` con verificación de cuenta y proveedor.
- [ ] (P0) **Restaurar el refresco de token en los entornos con sesión propia.** V4 lo quitó de `leer-cuota.mjs`, `leer-cuota-grok.mjs` y `ops/cuotas/cuotas`; sin él, Claude deja de leer a las ~8 h, Grok a las ~6 h y Codex a los ~10 d. Refrescar con escritura atómica solo bajo un flag que pasa el runtime de cuotas; en contenedores de agentes nunca se refresca. ✓ Tests con fetch simulado y recibo real de un entorno autenticado hace >9 h con ventanas ok.
- [ ] (P1) Datos actuales sin pulsar botones: al abrir «Mis cuotas» o la ficha, encolar `query` para cada entorno con captura de más de 10 min (idempotente por ventana de 10 min). ✓ Reabrir en el mismo intervalo no duplica.
- [ ] (P0) Prueba de uso cotidiano: 24 h después de autenticar, abrir «Mis cuotas» en producción y ver datos frescos sin abrir ninguna terminal. ✓ `captured_at` < 15 min y el mismo % que `coutas`.

### §4 Oficina interactiva y configurable

**4.1 Salas y agentes dinámicos** — parcial.
- [x] [código] Plano y campus derivan salas y agentes de `/v3/console/topology` sin nombres fijos; un poller cada 30 s; el layout descarta salas retiradas (PG 8/8).
- [x] [local real] CRUD de sala y membresía desde `/config` en navegador+PG (no comprueba la vista de oficina).
- [ ] (P1) **Bug de alcance**: la topología se calcula con el tenant de origen y el plano con la empresa activa; al cambiar de empresa, el super-admin ve salas ajenas y guardar da 403. Filtrar la topología por empresa activa. ✓ Test PG: tras cambiar a B, la topología lista solo B y el PUT del plano da 200.
- [ ] (P1) Ampliar el e2e de `/config` para comprobar en «Plano editable» que la sala aparece, cambia de nombre y desaparece.
- [ ] (P2) Recargar la topología tras un cambio de configuración, sin esperar 30 s.

**4.2 Detalle del agente desde la oficina** — parcial.
- [x] [código] Clic en el plano o el campus abre la ficha con estado, motivo, cola y cuotas, y enlaza a chat, terminal y «Perfil y contexto» (historial, diferencias y restauración).
- [ ] (P1) e2e real: clic en el plano → ficha con cuenta → historial de versiones.

**4.3 Cansancio por agente** — parcial.
- [x] [código] Estados distintos para sin datos, error, datos antiguos, agotado, cansado (<25 %), pausa y «varía por modelo», visibles en plano, tarjeta del campus y ficha; tests que impiden confundir sin datos/error con agotado.
- [ ] (P1) e2e con cuentas sembradas al 10 %, 0 %, en error y un agente sin cuenta. ✓ Etiquetas correctas en plano y ficha.
- [ ] (P2) Estado «Leyendo cuotas…» durante la carga (hoy muestra «Sin datos»); documentar y probar la regla con varias cuentas (gana el mejor estado).

**4.4 Mapa, salas y partes editables** — parcial.
- [x] [local real] Editor de geometría y partes con validación en cliente y servidor; guardado con CAS (un 409 conserva el borrador); guardar → recargar = fila SQL en Chromium+PG.
- [ ] (P1) **El campus debe seguir el plano guardado**: ordenar los edificios del campus por la posición guardada de cada sala (`campus-plan.ts:91`). ✓ Mover una sala en el plano y recargar cambia el orden del campus.

**4.5 Persistencia tras recargar, re-login y otro navegador** — parcial.
- [x] [local real] Tabla por empresa con versión CAS y auditoría; recarga verificada contra PG; salas homónimas entre empresas.
- [ ] (P1) e2e: guardar → cerrar sesión → iniciar sesión → mismo plano, y un segundo contexto Chromium lee la misma versión.

### §5 Migración de Gaia, Hegel, Hades y Argos

- [x] [local real] Relocalización entre hosts con slices selladas de origen y destino y aprobación de coordinador (fleet-relocation-postgres 5/5, fleet-operations-postgres 31/31).
- [x] [código] El mecanismo V3 para correr agentes fuera de la VPS ya funciona en producción (`placement.salva.dockerHost=server2`).
- [x] [local real] VPS identificada y medida; tamaños de los cuatro espacios medidos sin leer contenido (Gaia 3,1 MB + 3,6 MB de estado; Hades 498 MB, archivo máximo 91 MB; Argos 52 MB + 74 MB; Hegel 30 KB propios, los 30,5 GB son el `/workspace` compartido).
- [ ] **Hallazgo que condiciona el plan**: la flota V4 hoy solo puede colocar a Argos (openclaw con OpenAI). Gaia (openclaw con Anthropic), Hades (grok) y Hegel (muse) quedan fuera porque sus drivers de flota no soportan autenticación. Se resuelve en §7 (drivers por descriptor); si no llega a tiempo, la vía de respaldo es el overlay V3 `dockerHost=server2` (patrón Salva).
- [ ] (P1) Volver a preguntar a Kant por Cauce (con el CLI `cauce`; el conector MCP de GPT es lo que está UNAUTHORIZED): accesos, ventana de trabajo, linger del usuario `server`, límites de Minecraft y huella de server3. ✓ Pregunta y respuesta guardadas con id de mensaje y sha256.
- [ ] (P0) Fijar la vía de cada agente y su ubicación: los cuatro a server2 (uso actual ~2,3 GiB) con `--memory` por contenedor (≈1 GiB Gaia/Hades, 2 GiB Argos/Hegel); server1 como reserva; server3 solo si Kant confirma su huella. ✓ Tabla en `docs/v4-migracion-plan.md` con la medición del día y `docker inspect` con `HostConfig.Memory`.
- [ ] (P0) Registrar los bindings reales (cuenta, modelo, effort, pagador) leyendo su configuración y `auth status` en solo lectura, sin cambiar de cuenta. ✓ `primary_account_id` y `model_id` no NULL para los cuatro.
- [ ] (P0) Copia recuperable antes de cada corte (estado, workspace y sesiones, cifrada, a kratos y Drive), restauración de prueba aparte y **ensayo de reversión con Gaia**. ✓ sha256 de copia = listado restaurado; tras revertir, Gaia responde un nonce desde la VPS y se rehace el corte.
- [ ] (P0) Proyectos por git (mismo HEAD, sin commits sin publicar) y datos no versionados con manifiesto; `space_archive` omite `.git` y archivos con `auth|session|token|profile` en el nombre. ✓ Mismo HEAD y `git status --porcelain` en destino; sha256 iguales; omisiones con motivo.
- [ ] (P0) [DUEÑO] Credenciales en destino (§3, pregunta 2). ✓ Cada agente se autentica en server2 con la misma cuenta (mismo id en `auth status`) y 0 secretos en los recibos.
- [ ] (P1) Normalizar durante el traslado: rutas legadas → layout estándar (`/home/claw/clawd` → `space/projects`; `AGENTS.md`/`IDENTITY.md`/`SOUL.md` → `space/context`); contexto y directivas importados como primera versión. ✓ Manifiesto ruta vieja → nueva con sha256; el agente responde leyendo desde la nueva ruta.
- [ ] (P0) **Canario Gaia**, luego Hades, Argos y Hegel (Hegel con espacio propio y los repos que él indique, sin tocar `ws-humanizar`). ✓ Por alias: nonce respondido por Cauce desde server2, terminal por CLI y web, cuota de su cuenta, contexto aplicado (versión y digest) y host server2 en la UI; Argos inspecciona la VPS desde server2; `ws-humanizar` sigue sirviendo a Atlas y Kratos.
- [ ] (P1) Liberar origen tras 7 días sin incidentes: borrar `agv2-miguel-finca-oc` y `agv2-steven-hades-oc` con sus imágenes; en `ctrl-infra` y `ws-humanizar` quitar solo las unidades y el estado de Argos y Hegel. ✓ `docker ps -a` ya no los lista y los demás procesos siguen vivos.
- [ ] (P1) **Medición antes/después con un único script** (`free -b`, swap, `df -B1`, `docker stats --no-stream`, RSS por proceso de Argos y Hegel dentro de sus contenedores compartidos). ✓ Dos recibos con sha256 y la diferencia por alias. Ahorro esperado modesto (~0,5 GiB RAM y ~5,7 GB de imágenes por Gaia y Hades; Argos y Hegel liberan solo sus procesos).
- [ ] (P1) Ubicación final registrada (host_id en V4 y `ops/flota-fisica.json`) en el informe final.
- Regla de decisión: si el prechequeo del deploy no alcanza MemAvailable ≥ 8 GiB, Gaia y Hades pueden trasladarse antes por el overlay V3, normalizando su layout en el mismo paso.

### §6 Gestión de recursos, Docker y CLI `cauce`

**6.1 CRUD de entidades desde la UI** — parcial.
- [x] [local real] Clientes (= tenants, «Clientes» en `collections.ts:13`), salas, membresías y registro de agente con previsualización, CAS y 409 por dependencias en Chromium+PG (`ui-crud-v35-real-browser`).
- [x] [local real] Empresas, cuentas de cuota, plano de oficina e invitaciones con readback en PG.
- [x] [código] Ordenadores (alta/edición/baja con rechazo si quedan agentes u operaciones), personas (alta, edición, retiro, restauración, purga) y entornos de cuota con API y PG.
- [ ] (P1) **Matriz CRUD verificable por máquina** (archivo de datos: entidad × C/R/U/D → ruta API, control UI y test). ✓ Un test falla si falta una ruta, un test referenciado o una celda sin justificar.
- [ ] (P0) e2e en navegador real para ordenador (alta/edición/baja), personas y admins, entornos de cuota, contextos y empresa con registro. ✓ `pnpm test:e2e` en PASS con readback en PG.
- [ ] (P2) Purga de empresa retirada solo para el platform_admin (o reutilizar empresas de prueba reservadas).

**6.2 Agentes reales desde la web** — parcial.
- [x] [código] Alta en dos pasos (registro + «Preparar en la computadora»), operaciones create/update/start/stop/retire/restore/purge con preview y enqueue; retiro reversible y purga.
- [x] [local real] Executor contra Docker real local (`test_fleet_executor_container` 4/4, `test_fleet_executor_templates` 17/17), sin gateway ni web.
- [ ] (P0) **Ciclo físico desde la web**, primero con Docker local y luego en server2: crear (contenedor y volúmenes etiquetados), editar y aplicar contexto con ACK real, detener, retirar y purgar. ✓ `docker ps -a`/`docker volume ls` antes y después, respuesta real del proveedor, versión de contexto con ACK y 0 recursos del agente tras purgar.
- [ ] (P1) La purga deja huérfano `<contenedor>-provider-profiles` con la sesión del proveedor dentro: borrarlo tras la revocación (o registrarlo como retenido con dueño y comando de limpieza). ✓ Test con Docker real.
- [ ] (P1) Diálogo de purga honesto: nombrar contenedor y volúmenes, enlazar «Descargar copia» y exigir escribir el alias. ✓ Test de componente.
- [ ] (P1) Limpiar lo que deja un create fallido (hoy la compensación solo detiene procesos). ✓ Test con Docker real: 0 contenedores y 0 volúmenes tras compensar.
- [ ] (P2) Insignia «sin entorno» en agentes registrados sin placement.

**6.3–6.4 Orquestador de espacios en ordenadores registrados** — parcial.
- [x] [código] `create_container` endurecido (imagen por digest, red none por defecto); placement exige host registrado y con transporte; coordinador y executor con lease, epoch y token; hosts y capacidades firmadas (PG 12/12).
- [ ] (P0) **Instalar en el VPS el enclave de autoridad firmado** (`services/gateway/dist/fleet/authority/signed-main.js`, hoy sin unidad ni servicio) y configurar `CAUCE_FLEET_AUTHORITY_SOCKET`, `OWNER_UID`, `PEER_UID`, `COMMAND_FILE` y `DATABASE_URL_FILE`. ✓ La acción `ready` del enclave sale ok y server2 obtiene autoridad firmada.
- [ ] (P0) Enrolar server2 en Humanizar con worker del usuario `server` (linger, como Salva) y operar con dos computadoras. ✓ server2 `reachable` con capacidades de <120 s; sigue activo tras reiniciar.
- [ ] (P0) Smoke en server2: crear, autenticar, arrancar, detener y purgar un agente de prueba desde la UI. ✓ 0 recursos `cauce.fleet.*` al final.
- [ ] (P2) Publicar memoria y disco libres en las capacidades y mostrarlos en el selector de computadora.

**6.5 CLI `cauce`** — parcial.
- [x] [local real] Despacho nuevo (`platform`, `hosts`, `context`, `context-native`, `spaces`) añadido sin romper lo existente; suites del CLI en PASS (`remote-cauce-routing`, `test-cauce-cli-*`, `test-install-cauce-cli`).
- [ ] (P0) **Terminal por CLI para agentes en flota dinámica**: hoy `cauce <alias>` se rechaza con `CAUCE_FLEET_RUNTIME_STATE` (diseño de V3.5, no regresión). Al migrar, los cuatro perderían la terminal. Permitir entrar y ver resolviendo host y usuario desde el inventario aplicado o por el relay de terminal con sesión nominal; on/off/retirar siguen por la consola. ✓ Test con inventario de prueba y recorrido real con un agente migrado.
- [ ] (P1) `cauce login` (sesión 0600 sin copiar cookies a mano) y `cauce spaces create|list|edit|retire`. ✓ Test contra gateway y PG reales.
- [ ] (P1) Instalar el CLI en server2 y verificar `install-cauce-cli.sh`, `hosts enroll`, heartbeat y `spaces backup`.

**6.6 Copias descargables de espacios** — parcial.
- [x] [local real] `space_archive.py` con sha256 por archivo, identidad y omisiones; límites 1 GiB / 128 MiB / 20 000 entradas; flujo durable con fencing (PG 16/16); restauración por CLI de un JSONL de >96 MiB con hash igual.
- [ ] (P0) **Bug: la consola rechaza copias de más de 32 MiB** (`space-backups-client.ts:3,32,55`) aunque el backend admite 1 GiB, incluso al leer el estado. Alinear y descargar por enlace/stream mostrando el sha256. ✓ Test con un recibo de 100 MiB y descarga en Chromium de una copia de >32 MiB.
- [ ] (P1) La copia omite `.git` y código con `auth|session|token|profile` en el nombre (`src/auth/login.ts`, `session.py`…). Limitar el filtro a credenciales reales (`.env*`, `*.pem`, `*.key`, `auth.json`, `credentials*.json`, cookies). ✓ Un proyecto con esos archivos se restaura completo y `.env`/`auth.json` siguen omitidos.
- [ ] (P0) Copia y restauración real de un espacio vivo descargado desde la UI. ✓ Hashes iguales, identidad igual y ninguna ruta de otros agentes o empresas.
- [ ] (P1) Runbook de recuperación con comandos exactos (hoy es una frase).

**6.7 Estados reales de operaciones** — parcial.
- [x] [local real] El servidor rechaza pasos sin evidencia y el settle sin pasos acreditados; la UI solo muestra estados del servidor; una copia es `ready` solo tras verificar bytes, sha256 y manifiesto.
- [ ] (P1) e2e contra server2 con fallos reales (host apagado, timeout, error de Docker). ✓ La UI nunca dice «Completada» si el host no completó.

**6.8 Reintentos, interrupciones y huérfanos** — parcial.
- [x] [código] Contenedor idempotente por nombre; volúmenes reutilizados solo con etiquetas esperadas; purga reintentable; claims cercados.
- [ ] (P1) **Barrido de huérfanos** como paso del gate (contenedores y volúmenes `cauce.fleet.*` sin fila, operaciones sin estado final, invitaciones pendientes). ✓ Falla con un volumen sembrado y devuelve 0 al final del e2e físico.
- [ ] (P1) Interrupción física en server2: matar el executor entre create y start, reiniciar Docker y reanudar. ✓ 0 duplicados y la operación termina `succeeded`.

### §7 Sistema extensible de harnesses

- [x] [código] 8 descriptores JSON de esquema 1 validados, empaquetados y fijados por digest; parsers cerrados en TS y Python (O_NOFOLLOW, dueño, modo, tamaño).
- [x] [local real] En «Mis cuotas», capacidades, login, consulta y update se derivan del descriptor aprobado; un descriptor alterado retira la capacidad (12/12).
- [ ] (P0) **Los datos de operación al descriptor**: argv de authenticate, argv de quota, paquete de update y módulo proveedor de flota. Validación cerrada (argv absoluto bajo `/usr/local/bin`, sin metacaracteres, paquete con regex npm). Eliminar `LOGIN`/`QUOTA`/`PACKAGES` de `harness_operations.py`. ✓ Cambiar el argv en un bundle temporal cambia el comando; un argv relativo o con shell se rechaza.
- [ ] (P0) **Derivar del directorio de descriptores** las listas consultadas en runtime (`HARNESSES`, `harness-descriptor.ts:16`, `copy-bridges.mjs:14`, `runtime-package-smoke.mjs:209`, `quota_runtime.PROVIDERS`, `fleet_executor_templates.py:213`). ✓ Un descriptor nuevo aparece en operaciones, cuotas y plantillas sin tocar esos archivos.
- [ ] (P0) **Test de paridad** para lo que no se puede derivar en runtime (enums TS, CHECK de 057, bins, consola) con allowlist de proveedores que no son harness (gemini, minimax, feihoa). ✓ Añadir un descriptor sin el resto de ediciones falla e imprime la lista exacta de archivos.
- [ ] (P1) **Flota por descriptor**: el executor elige harnesses y hooks de proveedor desde el descriptor; implementar la autenticación de flota para grok, muse y openclaw+Anthropic (necesario para migrar Gaia, Hades y Hegel por V4). ✓ Quitar `install` de un descriptor retira el harness de las plantillas; los tres drivers autentican en un test.
- [ ] (P1) Descriptores honestos: declarar solo lo implementado (hermes/opencode sin auth/update/quota; openclaw y muse sin update/quota; grok sin update) o implementarlo. ✓ Test que recorre los 8.
- [ ] (P1) Errores con ruta de campo y motivo (hoy genéricos; el symlink sale como `OSError`). Capacidades por acción con motivo (hoy todo-o-nada: grok pierde `query` por no tener `update`).
- [ ] (P1) Alinear catálogos de UI con los descriptores (`ARNESES_REALES`, `harness_definitions` de BD, gemini en enums de cuota); retirar del editor el campo inerte `harness_definitions.command`.
- [ ] (P0) **Alta de punta a punta** con un harness de prueba (`fake2`) siguiendo el runbook: descriptor + ediciones que liste el test de paridad, validación, empaquetado y ejecución real con `ops/harness/adapter-roundtrip.mjs`. ✓ En verde, con el número de archivos tocados registrado.
- [ ] (P0) Ejecutar físicamente `quota` y `update_cli` resueltos por descriptor en un entorno de server2. ✓ Recibo con sha256 del descriptor, argv, exit y ventanas.
- [ ] (P1) Runbook de alta en `docs/v4-archivos-contextos.md` con la lista que imprime el test y el mapa proveedor↔harness.
- [ ] (P2) Eliminar `executeHarnessOperation` y `lifecycle_plan` (solo los usan tests); aplicar o retirar `context.native_document` (hoy forzado a `none`).

### §8 Archivos de los espacios y contextos versionados

**Estructura de archivos (8.1–8.5)** — parcial.
- [x] [código] `SPACE_DIRECTORIES` (7) y `prepareSpaceLayout` (0700, sin symlinks); el executor V4 deriva y verifica `CAUCE_SPACE_ROOT`; el SDK materializa `context/`, `directives/` y `config/context-state.json` por turno; copias con allowlist y exclusión de secretos probada con secretos sembrados (11/11, 8/8); credenciales fuera de `space/`.
- [x] [código] Documentación por directorio en `docs/v4-archivos-contextos.md:5-30`.
- [ ] (P0) El supervisor legacy (`container-adapter-supervisor.sh:666`, lanzado por 12 unidades rootless) no pone `CAUCE_SPACE_ROOT`: añadirlo. ✓ `/proc/<pid>/environ` de cada agente activo lo contiene y existen los 7 directorios.
- [ ] (P0) `cwd` del arnés en `space/projects` (`CAUCE_AGENT_WORKSPACE`), relajar el workspace fijo de muse y declarar los workspaces compartidos (Hegel, Argos) como montaje externo excluido de la copia con motivo. ✓ Un archivo de proyecto aparece en `space/projects` y en la copia.
- [ ] (P1) Productores reales para `tmp/` (TMPDIR) y `logs/` (log acotado y rotado del adaptador), o retirar esos directorios y documentar el destino real.
- [ ] (P1) Inventario dry-run de los 14 agentes de `ops/flota.json` y de Praxis (`space_archive.py --dry-run`: ruta, tamaño, sha256, motivo de exclusión; sin contenido). ✓ Manifiesto por agente; cada ruta clasificada en la guía o marcada «desconocida».
- [ ] (P1) Documentar el layout completo por agente, incluida la raíz del `state_directory` (inbox, outbox, fencing, sockets, `terminal-history`, `.cauce-credentials`, caché de ZIP) como persistente, regenerable o eliminable.
- [ ] (P0) Migración verificable de cada agente (copiar sin mover; manifiestos antes/después; reversión = reapuntar al workspace original), in situ para la flota que se queda y junto a §5 para los cuatro. ✓ Diff de manifiestos sin pérdidas; restore probado una vez.
- [ ] (P0) Desplegar y verificar por host: mounts, `CAUCE_SPACE_ROOT` en procesos, los 7 directorios y una copia descargada desde la UI.

**Repositorio compartido y versionado (8.6–8.16)** — base sólida, falta lo real.
- [x] [local real] **8.8 aislamiento** entre empresas en el repo compartido: autoridad por empresa, el sink nunca recibe el snapshot de otra empresa, solo el gateway monta repo y clave.
- [x] [local real] **8.9 identidad estable**: la clave es `(company_id, tenant_id, alias)`; el alias es inmutable y el nombre visible y la sala son editables sin perder historial (PG).
- [x] [local real] **8.10 registro** con archivos completos, digest, origen, `restored_from`, autor humano o alias y fecha; el runtime solo tiene SELECT/INSERT; `.cauce-version.json` lleva autor/origen/fecha al commit.
- [x] [local real] **8.16 qué entra en Git**: solo `context/` y `directives/` con extensiones de texto, sin segmentos sensibles y con escaneo de secretos revalidado en el commit.
- [x] [local real] Broker con índice temporal, `update-ref` con CAS, replay idempotente y push con comprobación de ancestría; push fallido conserva el commit y el retry sincroniza (PG + Git bare); smoke sintético en `stevenvo780/cauce-agent-contexts` con limpieza.
- [x] [local real] Estados separados guardado / Git / GitHub; la UI solo dice «Sincronizado» con `synced`; CAS + lock por agente; commits serializados.
- [ ] (P0) Preflight del repo del broker en la VPS: dueño uid 1000, raíz 0700, `.git` sin escritura de grupo/otros, `core.sshCommand` con la deploy key y `main` = `origin/main`. ✓ Dentro del gateway V4: `rev-parse main` = `ls-remote origin main` y `push --dry-run` exit 0.
- [ ] (P0) **Sembrar el historial de los agentes reales** (no hay backfill): operación idempotente que registra la versión inicial de cada agente activo desde su perfil y documentos nativos y la empuja. ✓ `git ls-tree origin/main` lista las carpetas de Humanizar (y Praxis tras importarla); re-ejecutar no crea versiones.
- [ ] (P0) **Versionar las ediciones hechas en el espacio del agente**: hoy no quedan en el historial y además bloquean los turnos siguientes (`VERSIONED_CONTEXT_CHANGED`; «active context file was edited locally»). Ruta de ingesta autenticada por mTLS del agente con CAS; en conflicto se conserva el archivo local y se muestra. ✓ El agente edita `context/x.md`, aparece la versión N+1 con origen native y autor = alias, y el turno no falla.
- [ ] (P0) Desplegar y empujar a GitHub un contexto real escrito por la API o la UI (el worker de outbox corre dentro del gateway). ✓ `synced` con `git_commit` = `ls-remote`.
- [ ] (P0) **Turno real que adopte la versión** (Claude y Codex como mínimo). ✓ `applied_version`=N con el mismo digest y `context.adopted` con harness y turno nativo reales.
- [ ] (P1) Recuperación de divergencia: el broker nunca hace fetch; hacer fetch de `origin main` antes del commit y usar `origin/main` como padre si `main` local es ancestro. ✓ Con un remoto adelantado, termina `synced` sin perder ningún commit.
- [ ] (P1) Concurrencia de varios agentes: dos del mismo tenant y uno de otra empresa en paralelo. ✓ Las tres carpetas y tres commits en el remoto.
- [ ] (P1) Desacoplar el lector V3 de repositorio (`console/context-repository/*`) de la raíz del broker (formato y layout incompatibles) o retirarlo.
- [ ] (P1) Mostrar el autor de cada versión en el historial; e2e real de guardar, historial, diff y restaurar.
- [ ] (P1) Director o anclaje por empresa para aplicar contextos (Humanizar y Praxis). ✓ Un apply real no da «director unavailable».
- [ ] (P1) Ensayar en el despliegue un fallo de envío y su recuperación; escanear el remoto con gitleaks tras sembrar (0 hallazgos); retirar la carpeta sintética `v4_verificacion`.
- [ ] (P1) **Una sola fuente de contexto**: generar el documento nativo (`CLAUDE.md`/`AGENTS.md`) desde la versión aplicada para que el agente no use otra directiva sin aviso.

### §9 Auditoría, diagnóstico y poda

- [x] [código] Ids de cadena ya existentes: `trace_id` de mensajes de extremo a extremo, `trace-<uuid>` por apertura de terminal registrado en el pty-agent, `operation_id` durable hasta el executor.
- [x] [código] `audit_events` con tenant, actor, request/trace/delivery/message id, `company_id` y `actor_human_id`; `fleet_operations` con actor, pasos, error y host ejecutor; copias con códigos de error durables; resumen saneado.
- [ ] (P0) **Inventario de uso real** medido en producción V3 en lectura: `audit_events` por acción en 90 días y lectores, JSONL de decisiones, timers de `ops/guardias`, alertas de `ops/observability`, medico-monitor y telemetrías. ✓ `docs/v4-diagnostico.md` con productores, consumidores, último uso, problemas detectados y decisión por mecanismo.
- [ ] (P0) **Podar lo que no aporte** tras comprobar dependencias. Candidatos: cinco guardias de credenciales solapadas (`cred-guard.py`, `cred-guard.sh`, `cauce-cred-guard-kratos.py`, `credential_health.py`, `cauce-credenciales`), la doble escritura JSONL+PG de decisiones (si falla PG tampoco se escribe el JSONL) y el lector V3 de contextos. No podar `audit_events` por edad (es candado de idempotencia). ✓ `git diff --diff-filter=D` lista lo retirado, `rg` sin referencias residuales y suites de regresión en verde.
- [ ] (P0) `listAudit` solo devuelve filas del propio actor, así que un dueño no ve los eventos de sus agentes, y el filtro por trace actúa en el navegador. Lectura por empresa (`COALESCE(audit.company_id, tenants.company_id)`) y filtros en servidor por trace, alias y acción, devolviendo empresa y host. ✓ Test PG: el dueño de A ve sus eventos y ninguno de B.
- [ ] (P1) Consulta de cadena `cauce diagnose <id>` (o vista): dado un trace/operation/session/delivery/copia, junta auditoría, entregas, operaciones, outbox de contexto y copias. ✓ Test PG con un id de cada tipo.
- [ ] (P1) Guardar la causa saneada de los fallos de sync (hoy `catch {}`): autenticación, red, no fast-forward, timeout, repo no privado. Estandarizar `metadata.host_id` y `component` en terminal, contexto y copias.
- [ ] (P0) **Ensayar rupturas reales** (host/SSH caído en una operación, terminal cortado, error del CLI, push rechazado) y localizar cada una solo con los registros. ✓ Recibo con id, componente y causa de las cuatro.
- [ ] (P1) Revisar que no haya secretos en `audit_events` y 7 días de logs de gateway, relay y pty-agent.

### §10 UI/UX, pruebas y documentación

- [x] [local real] Matriz `pnpm test` 12/12 sobre `533d245e` (unit 7 234, services 3 574, store-hardening 1 770, runtime-role 3 603, e2e 141); SSH real local con sshd efímero; Docker real (testcontainers, container-supervisor); PTY real (134); GitHub real sintético.
- [x] [local real] 17 e2e con navegador real y PG por testcontainers (vistas V3); formularios V4 con validación y diálogos de confirmación; recorrido V4 de 12 pasos en Chromium+PG (fuera del repo).
- [ ] (P1) Versionar el recorrido V4 en `tests/e2e/v4-console-real-browser.test.ts` (con los pasos de oficina, contextos y una entrada inválida por formulario V4) y corregir su selector ambiguo. ✓ `pnpm test:e2e` sin reintentos y 0 errores de navegador.
- [ ] (P1) Añadir las vistas V4 a `console/qa/layout-gate.mjs` (`/my-quotas`, plano, computadoras, general) a 390 y 1 440 px.
- [ ] (P1) Pruebas de fallo con procesos reales: caída y reconexión de sshd a mitad de operación; matar gateway y worker a mitad de una operación de flota; GitHub con dos escritores y un push fallido. ✓ Sin efectos duplicados y estado final explícito.
- [ ] (P0) Prueba real con proveedor: leer la cuota de una cuenta existente de un agente de Humanizar por el mecanismo V4 en un host real.
- [ ] (P1) Recursos de prueba `zz-canary-<run>` con limpieza que solo toca ese prefijo. ✓ Inventario antes = después y auditoría sin ids de Humanizar ni Praxis.
- [ ] (P1) Tabla de pruebas reales por categoría (SSH, Docker, terminales, proveedores, GitHub, comunicación entre agentes) con recibo sobre el SHA final o bloqueo explícito.
- [ ] (P0) `docs/v4-guia.md`: guía de uso y administración por área de §10.7, enlazada desde README y `docs/consola.md`. ✓ Cada afirmación comprobada en el despliegue.
- [ ] (P0) Subsección «Desplegar V4» en `docs/operacion.md` (no otro runbook): prerrequisitos (broker, enclave, ensayo de migración, backup fresco), orden deploy.sh → adapter → controlador, verificaciones, ventana de reversión, backup/restauración de espacio, migración de agentes, enrolamiento y diagnóstico. ✓ Cada comando aparece en el recibo del despliegue.
- [ ] (P1) Corregir los docs desfasados (`v4-consola.md` dice que no hay E2E real y que las escrituras antiguas requieren enlazarse; varios dicen 32 MiB) y **quitar las 57 rutas privadas** de `docs/v4-*.md`. ✓ `grep -cE '/home/stev|/tmp/|/var/tmp' docs/*.md` = 0 en el SHA desplegado (salvo la especificación literal).

## 5. Integración, despliegue y release

- [x] [local real] Backup predeploy del 12-oct aprobado: 6 artefactos, 250 950 042 bytes, hashes iguales en origen y kratos, restore aislado sin red, revisión independiente `APPROVE` (ya caducado para la ventana real).
- [x] [local real] Restore aislado de producción con 052–064 aplicadas y datos legados intactos (21 856 mensajes, 20 412 entregas, 29 290 outbox); downs 052–065 presentes.
- [x] [código] `deploy/deploy.sh` ampliado sin romper el contrato build→pin→migrate→up→smoke; migraciones en una transacción con `lock_timeout`.
- [ ] (P0) Revisar los 6 secretos de GitGuardian (§3, pregunta 1): gitleaks/trufflehog local con reglas genéricas sobre `94959fb0..HEAD`, sustituir contraseñas de fixture por placeholders evidentes y rotar si algo es real. ✓ Check de GitGuardian en verde o falsos positivos marcados.
- [ ] (P0) Gate completo una sola vez sobre el SHA candidato: `pnpm typecheck`, `lint`, `test` (12 suites), `coverage:ratchet` (consola ≥ 94,49 %), `qa:testcontainers`, `qa:layout`, `qa:runtime-packaging`, `ops:validate`, `arch:validate`. ✓ Un log por comando con `git rev-parse HEAD` = candidato y exit 0.
- [ ] (P1) Revisión independiente (Opus 5.5) del diff de cierre y de las migraciones 052–065, centrada en aislamiento, seguridad y regresiones. ✓ Informe ligado al SHA; cada bloqueante corregido con su prueba.
- [ ] (P0) Integrar: merge del PR #151 + commits de cierre a `dev` y fast-forward de `main` (merge-base = `94959fb0`, sin conflictos). ✓ `origin/dev` = `origin/main` = SHA gateado.
- [ ] (P0) Adaptar `rehearse-v41-clone.sh` a todo el bundle (052–065) y ejecutarlo con la imagen candidata contra el último dump. ✓ exit 0; con locks contendidos falla sin aplicar nada; down hasta 051 y up conservan las filas legadas.
- [ ] (P0) Prechequeo del VPS: MemAvailable ≥ 8 GiB, ≥ 20 GB libres (o `docker builder prune -f`), bind mounts `create_host_path:false` del broker presentes (`/var/lib/cauce-v3-context-broker/{repository,ssh}`), compose con overlay de flota renderiza, `cauce-fleet-v35-controller` activo. ✓ Salidas guardadas antes de lanzar.
- [ ] (P0) Backup fresco inmediatamente antes (`cauce-v3-host-backup`) y deploy con `CAUCE_DEPLOY_BACKUP_MAX_AGE_HOURS=2`. ✓ `host-backup-monitor` ok y dump en kratos con el mismo sha256.
- [ ] (P0) `deploy/deploy.sh` desde un bundle limpio del SHA en el VPS (`CAUCE_DEPLOY_FLEET_OVERLAY=1`, `CAUCE_FASE3_CON_DUENO=si`, `CAUCE_DEPLOY_CONFIRMADO=si`, `EXPECTED_GIT_REF=origin/main`); si falla up o smoke, «Rollback exacto» de `docs/operacion.md` §1. ✓ Fila en `deploy/HISTORIAL.md`; `schema_migrations` = 065; `org.opencontainers.image.revision` = SHA y `io.cauce.source.digest` coincide.
- [ ] (P0) Herramientas de flota del host a V4: `build-adapter-release.sh`, `fleet-controller-upgrade.py` en preflight y luego `--apply` (respetando uid 1000 y 0700/0600 en `/etc/cauce-v3/fleet-v35/gateway`). ✓ Exit 0 sin «ROLLBACK INCOMPLETE»; heartbeat actualizado.
- [ ] (P1) Humo de mecanismos conservados: `deploy/smoke.sh`, entregas con ACK, terminal de un agente desde la consola, `cauce flota` y `cauce coutas`.
- [ ] (P0) **Ciclo completo**: deploy → recorrido desplegado → corrección con prueba que falla en el SHA desplegado → redeploy → nuevo recorrido, hasta 0 flujos esenciales en rojo. ✓ Recibos ligados a cada SHA y filas de HISTORIAL.
- [ ] (P0) Comprobar al final que `origin/main` = SHA del gate = revisión de las imágenes en ejecución, con el source digest recalculado.
- [ ] (P1) Documentar la ventana de reversión de V4: mientras no haya datos V4 nuevos, down o restore + pins `prod.env.pre-deploy-<STAMP>`; con owners o empresas nuevas, `down/054` se niega y hay que corregir hacia delante.

## 6. Mejoras no contempladas (incorporadas al alcance)

Validadas por la pasada Opus; cada una con su comprobación.

1. (P0) **Higiene de secretos en GitHub antes del merge** — ver §5. Además, sacar del código los identificadores de cuentas del dueño (`CLAVE_POR_ACCOUNT`, correos en comentarios) a configuración privada del host.
2. (P0) **Recibo de gates en el repo ligado al SHA**: `scripts/release-gates.sh` corre en orden los comandos pnpm existentes y escribe `{commit, exits}`; `deploy.sh` exige ese recibo con commit = HEAD. ✓ deploy.sh se niega sin recibo verde del SHA.
3. (P1) **deploy.sh más seguro**: comprobar las fuentes bind del compose antes del build; escribir los pins en `prod.env` solo tras un migrator con exit 0; exigir backup ≤ 2 h cuando hay migraciones pendientes. ✓ Tests de deploy con cada caso.
4. (P1) **Ensayo de migración genérico**: derivar tablas y columnas toleradas de las migraciones del bundle (no la lista fija de 053) y documentarlo como paso previo en `operacion.md`.
5. (P1) **Seed del super-admin sin SQL manual**: `cauce platform admin semilla --email` idempotente; y **unificar los dos CLIs de plataforma** (`cauce-plataforma` → subcomandos de `cauce platform`).
6. (P1) **Una sola lectura de cuotas compartida** (un poller en `FleetProvider` que alimente plano, campus y ficha).
7. (P1) **Mensajes de error accionables** en entornos de cuota y registro (códigos estables `email_taken`, `company_slug_taken`… traducidos con la acción siguiente); `capabilities()` dice por qué descarta un proveedor; recuperación de un `update_cli` fallido sin romper el CLI de la imagen.
8. (P1) **Pantalla «Empresa retirada»** con cierre de sesión cuando la autoridad queda en `none`.
9. (P1) **Validar `harness_definitions` de BD contra los descriptores** y rechazar un harness sin descriptor publicado por el host.
10. (P1) **Autor real en `git log`** de contextos (`GIT_AUTHOR_NAME` = alias o humano; broker como committer) y **aplicación en el siguiente turno natural** (el turno dedicado solo con «Aplicar al agente»), para no gastar cuota de más.
11. (P1) **Inmutabilidad del historial de contextos** con trigger que rechace UPDATE/DELETE en `agent_context_versions`.
12. (P1) **Contrato entre los handlers MSW y las rutas reales del gateway** (test que compara rutas), empezando por las V4.
13. (P1) **Preflight de dependencias nativas** en typecheck/test (node_modules vs `pnpm-lock`, `@napi-rs/canvas`) con mensaje de entorno explícito.
14. (P1) **Reservar los subcomandos del CLI** (`platform`, `hosts`, `spaces`, `context`…) como alias inválidos al registrar agentes.
15. (P2) Dependencias de Argos con la VPS: inventariar herramientas y endpoints que usa y darle acceso remoto mínimo (tailscale) antes de moverlo.
16. (P2) Retirar lo legacy tras migrar (`fleet_adoption_probe_*`, `fleet_executor_legacy*`) cuando los cuatro agentes estén en V4; separar la auditoría de dependencias npm (`ops/auditoria-permitida.json`) de la de diagnóstico.

Rechazadas por la pasada Opus (no entran): RLS sobre ~60 tablas (los triggers de 053 + la prueba adversarial cumplen el criterio literal), manifiesto expand/contract, alertas de cuota a Telegram, reducción de sondeos y retención de muestras sin medición previa, modo mantenimiento o congelación de escritores (el migrator ya es transaccional con `lock_timeout`), verificación de correo y recuperación de contraseña (la especificación no las pide).

## 7. Ruta crítica

| Fase | Contenido | Depende de |
|---|---|---|
| **A. Entorno y seguridad** | Rama `claude/v4-cierre` con dependencias y venv (hecho); revisión de los 6 secretos; lote de preguntas al dueño enviado. | — |
| **B. Correcciones previas al primer deploy** | Limitador de registro con IP real; copias >32 MiB en consola; purga honesta y sin huérfanos; alcance de topología por empresa; terminal CLI en flota dinámica; refresco de token de cuotas; motivo de fallo de cuota; `shared` antes del filtro; guardián que no escala cuentas compartidas; `CAUCE_SPACE_ROOT` y `cwd` del supervisor; siembra de contextos; prueba adversarial por enumeración de rutas; e2e V4 versionado; docs desfasadas. | A |
| **C. Gate e integración** | Gate completo una vez; revisión Opus del diff; merge a `dev`/`main`; ensayo 052–065 sobre dump fresco. | B |
| **D. Deploy 1** | Prechequeo VPS, backup fresco, `deploy.sh`, kit del controlador, enclave de autoridad, siembra de SA y owners, humo. | C |
| **E. Verificación desplegada + server2** | Recorrido del criterio 1, 2, 4 y 5 contra producción con empresas `zz-canary`; enrolar server2 (executor, ejecutor de cuotas, imagen de cuotas); ciclo físico de agente y entorno de cuota; [DUEÑO] login real; simulacros de fallo. | D |
| **F. Harnesses y diagnóstico** (en paralelo desde C) | Descriptores con comandos, derivación y paridad, flota por descriptor (grok, muse, openclaw+Anthropic), alta `fake2`; inventario y poda de auditoría, `listAudit` por empresa, consulta de cadena, membresías 066. | C |
| **G. Deploy 2** | Integrar F + correcciones de E, gate, deploy, re-verificar lo afectado. | E, F |
| **H. Contextos reales** | Preflight del broker, siembra en GitHub, ediciones desde espacio, turno real con adopción, concurrencia y fallo de sync. | G |
| **I. Migración** | Kant, bindings, copias y reversión, canario Gaia → Hades → Argos → Hegel, medición antes/después, liberación tras 7 días. | E, G, H |
| **J. Praxis** | Inventario, empresa con León, batch `platform change`, [DUEÑO] corte con enrolamiento del hospital. | D, G |
| **K. Cierre** | Guía, subsección de operación, informe final con SHA desplegado y tres niveles, deploy final y recorrido completo. | I, J |

## 8. Criterios de aceptación (sección 12, literal) y su estado

> **La V4 solo puede considerarse terminada cuando se cumplan y verifiquen los siguientes criterios.** Ningún criterio está cumplido entero todavía; dentro de cada uno se marcan las cláusulas ya acreditadas.

- [ ] **1. Multiempresa operativa y aislada.** Humanizar y Praxis funcionan con sus recursos reales. Un usuario nuevo puede registrarse, crear su empresa y utilizarla. Las pruebas confirman que no puede acceder a datos ni ejecutar operaciones de otra empresa, tampoco manipulando solicitudes fuera de la interfaz.
  - [x] [local real] Un usuario nuevo se registra, crea su empresa y entra como owner (Chromium+PG, árbol intermedio).
  - [x] [local real] Aislamiento por familias de rutas y en BD (triggers de 053, tests PG, dos empresas en navegador).
  - [x] [código] Alta pública y atómica conforme a la especificación.
  - [ ] Humanizar con sus recursos reales en V4.
  - [ ] Praxis con sus recursos reales.
  - [ ] Registro utilizable en producción (limitador global por falta de IP real).
  - [ ] Solicitudes manipuladas cubiertas de forma exhaustiva (enumeración de rutas) y probadas contra el despliegue.
  - [ ] Todo lo anterior verificado en el despliegue.

- [ ] **2. CRUD completo y real.** Se han probado creación, consulta, edición y eliminación de todas las entidades administrables, tanto desde la interfaz como en sus efectos persistentes y remotos. No quedan botones ficticios, operaciones incompletas ni recursos huérfanos tras las pruebas.
  - [x] [local real] Desde la UI con persistencia en PG: empresas, clientes (tenants), salas, membresías, registro de agente, cuentas de cuota, plano de oficina e invitaciones.
  - [x] [local real] Executor contra Docker real local: create, prepare, stop y purge con recursos desechables.
  - [ ] Agentes, ordenadores, personas, entornos de cuota y contextos con ciclo real desde la UI.
  - [ ] Efectos remotos: create/start/stop/rm en un host remoto real.
  - [ ] Sin huérfanos (purga deja `-provider-profiles`; create fallido deja contenedor y volúmenes) y barrido que lo demuestre.
  - [ ] Sin controles ficticios (campo inerte `harness_definitions.command`, proveedores gemini/grok sin ejecutor) y matriz CRUD verificable.

- [ ] **3. Gestión distribuida funcional.** Se pueden registrar ordenadores e instanciar, administrar y eliminar espacios y agentes en ellos. Gaia, Hegel, Hades y Argos funcionan en servidores locales, conservan su información y se ha comprobado la liberación de recursos en la VPS principal. El CLI `cauce` y las terminales remotas mantienen sus capacidades.
  - [x] [local real] Enrolamiento de ordenadores con identidad Ed25519 y heartbeat (helper local).
  - [x] [local real] Relocalización entre hosts y coordinador con PG real.
  - [x] [local real] El CLI `cauce` conserva su despacho previo (suites en PASS) y añade `platform`, `hosts`, `context`, `spaces`.
  - [ ] Un ordenador enrolado ejecuta agentes sin el administrador (falta instalador del executor).
  - [ ] Instanciar, administrar y eliminar espacios y agentes en un ordenador remoto real.
  - [ ] Gaia, Hegel, Hades y Argos en servidores locales con su información conservada.
  - [ ] Liberación de la VPS medida antes y después.
  - [ ] Terminal por CLI para los agentes en flota dinámica.

- [ ] **4. Cuotas reales desde la web.** Funcionan las cuotas por agente y la sección «Mis cuotas», incluyendo autenticación, consulta, actualización de CLI y administración de sus entornos. Se ha probado que varios agentes pueden compartir una cuenta sin errores ni saldos ficticiamente independientes. Las ventanas y los estados mostrados corresponden a los datos reales disponibles.
  - [x] [local real] «Mis cuotas» registra, edita y borra cuentas sin agente y fija tarjetas con persistencia.
  - [x] [local real] Estados fresco, viejo, desconocido y error explícitos; cuenta compartida modelada sin saldos independientes (PG).
  - [x] [código] Lectores que solo emiten las ventanas que informa el proveedor.
  - [ ] Entornos Docker reales: crear, autenticar, consultar, actualizar CLI y eliminar.
  - [ ] Cuotas por agente según su harness (openclaw y muse sin lector; consulta en el entorno del agente).
  - [ ] Cuenta compartida por dos agentes reales verificada en la UI.
  - [ ] Ventanas contrastadas con datos reales; refresco de token restaurado.
  - [ ] Verificado en el despliegue.

- [ ] **5. Oficina y harnesses operativos.** La oficina responde a la creación, edición, asignación y eliminación de salas y agentes; su configuración persiste; y el detalle de cada agente muestra correctamente sus cuotas y estado visual. El mecanismo de configuración de harnesses se ha probado con operaciones reales y no depende de cambios dispersos para cada integración.
  - [x] [local real] El plano se guarda y persiste tras recargar y en un segundo navegador.
  - [x] [código] Campus y plano derivan salas y agentes de la topología, sin agentes estáticos.
  - [x] [código] Cansancio con estados distintos para sin datos, error, antiguo y agotado, visible en plano, campus y ficha.
  - [ ] e2e de alta, edición, asignación y baja de salas y agentes reflejadas en la oficina.
  - [ ] El campus sigue el plano guardado; alcance de topología por empresa activa.
  - [ ] Ficha con cuotas y estado verificada con datos reales.
  - [ ] Harnesses probados con operaciones reales.
  - [ ] Alta de harness sin cambios dispersos (comandos y listas fuera del código; test de paridad).

- [ ] **6. Archivos ordenados y contextos versionados.** Los espacios utilizan la estructura estándar sin pérdida de datos ni rutas rotas. El repositorio compartido de GitHub contiene las carpetas de los agentes y registra sus cambios. Se han probado la edición desde las vías soportadas, el historial, las diferencias, la restauración, la aplicación efectiva al agente, las escrituras concurrentes y la recuperación después de un fallo de sincronización, sin exponer secretos ni contextos entre empresas.
  - [x] [local real] Escrituras concurrentes con CAS sin descartar contenido.
  - [x] [local real] Guardado, registro en Git y sincronización separados; un fallo de sync queda pendiente y recuperable.
  - [x] [local real] Historial, diff y restauración como versión nueva (backend).
  - [x] [local real] Identidad estable y aislamiento entre empresas en el repo compartido; solo texto de `context/` y `directives/` con escaneo de secretos.
  - [ ] Espacios reales con la estructura estándar, sin pérdida y con migración verificable.
  - [ ] Repo de GitHub con las carpetas de los agentes reales.
  - [ ] Edición por todas las vías (UI real, CLI y espacio del agente) registrada.
  - [ ] Aplicación efectiva al agente con un turno real; una sola fuente de contexto.
  - [ ] Recuperación de divergencia y fallo de sync ensayados en el despliegue; sin secretos en el remoto.

- [ ] **7. Copias, recuperación y diagnóstico comprobados.** Se puede descargar una copia del contenido de un espacio y restaurarla en un entorno de prueba. Los fallos relevantes dejan un rastro útil para encontrar su causa. La eliminación de componentes de auditoría innecesarios no ha roto funciones ni suprimido controles necesarios.
  - [x] [local real] Restauración en entorno de prueba con datos sintéticos (CLI con >96 MiB y hash igual; HTTP firmado 16/16).
  - [ ] Descarga de copias reales desde la consola (tope de 32 MiB).
  - [ ] Copia y restauración de un espacio real.
  - [ ] Rastro útil de fallos (lectura por empresa, consulta de cadena, causas saneadas, rupturas ensayadas).
  - [ ] Poda de auditoría hecha sin romper nada.

- [ ] **8. Pruebas reales en local y en el despliegue.** Se han ejecutado las pruebas correspondientes sobre la versión final integrada y se han recorrido los flujos esenciales en el entorno desplegado. No basta con que compile, pase el linter, funcionen los mocks o responda un endpoint de salud. Los errores encontrados se corrigen y los flujos afectados se vuelven a probar.
  - [x] [local real] typecheck, lint y test:unit en verde sobre `56c0c016` con entorno reproducible; matriz 12/12 sobre `533d245e`.
  - [ ] Gate completo y cobertura sobre la versión final integrada.
  - [ ] Flujos esenciales recorridos en el entorno desplegado.
  - [ ] Ciclo corregir → re-probar sobre lo desplegado.

- [ ] **9. Despliegue final y documentación completos.** Los cambios están integrados y desplegados; la versión publicada corresponde al código verificado; la documentación describe todas las funciones reales y los procedimientos de operación y recuperación; y no quedan pendientes críticos ocultos detrás de un «se hará después».
  - [ ] Integrado en `dev` y `main` (PR #151 abierto, GitGuardian en rojo).
  - [ ] Desplegado (producción en V3 `34cd5ea0`).
  - [ ] Versión publicada = código verificado.
  - [ ] Guía de uso y administración, y operación/recuperación V4 documentadas, sin rutas privadas.
  - [ ] Sin pendientes críticos (migración, Praxis, harnesses y diagnóstico siguen abiertos).

- [ ] **Informe final verificable** (`docs/v4-informe-final.md`): versión o commit desplegado, entornos comprobados, ubicación final de los agentes migrados, resultado de las pruebas y evidencias, distinguiendo implementado, probado en local y verificado en el despliegue.

> **No declares una prueba aprobada si no la ejecutaste. No declares una integración funcional si solo la simulaste. No declares terminada la V4 si siguen fallando flujos esenciales.** Si queda algún bloqueo, informa qué falta, qué impacto tiene y qué evidencia existe, sin presentar esa parte como completada.
