# Tarea 1 — Núcleo, autoridad y canal firmado de Cauce V4

Estado: núcleo y canal implementados y registrados en la rama aislada; validación focal con PostgreSQL hermético y rol SQL runtime real. La integración, el despliegue y la aceptación completa siguen pendientes. Este informe acredita el alcance indicado; el gate completo y la aceptación de V4 corresponden al integrador.

## Cambios e interfaces

- Migración nueva 055: registro atómico de empresa, hub, sala, alias humano, identidad scrypt, membresías y dueño. POST `/v3/auth/register` estricto `{email,name,password,company:{slug,name}}`; login posterior existente. Origin obligatorio, cinco intentos/IP/15min, cuatro hashes simultáneos. Receipt `{user:{id,username,email,name},company:{id,slug,name},hub:{id,name}}`, sin sesión implícita.
- Empresas GET/listado, POST con dueño nuevo, PATCH `{expected_version,name?,state?}`, DELETE con query `expected_version`: retiro lógico reversible por plataforma y datos preservados. SQL revalida dueño/plataforma y concurrencia; deadlock se comunica como conflicto recuperable.
- GET/PUT `/v3/console/companies/:company_id/admins`; PUT `{user_id,role:'owner'|'admin'|null,expected_version}`. Versión 0 para alta; generaciones monotónicas incluso tras revocar/recrear. Dueño administra admins; plataforma también owners. Self, última propiedad cualificada y empresa ajena protegidos.
- Autoridad única exige humano activo/operator, membresía humana control y control durable de sala/rol/tenant/agent vigente. Revocación baja inmediatamente alcance y también mensajería; configuración protege último dueño con el mismo criterio, aunque otro runtime aún controle el hub.
- Migración 056: GET/PUT `/v3/console/office/layout`, identidad compuesta `(tenant_id,room_id)`, partes, CAS y filtrado de salas ajenas/retiradas/purgadas. Preferencias GET/PUT `/v3/console/preferences`, por humano+empresa, pins canónicos visibles de `provider_accounts.id`.
- Migración 059: POST/GET `/v3/console/fleet/hosts/enrollments`; DELETE `/:enrollment_id` revoca pendiente. Invitación token hex64 de un uso, hash SHA256, nonce y TTL10min; claim máquina Ed25519 SPKI DER base64 canónico. Firma JSON estable ordenada `{version:1,enrollment_id,company_id,host_id,nonce}`. Límite claim20/IP/min, clave repetida produce conflicto sin filas parciales.
- Reintento de claim ya inscrito: admite exclusivamente token, challenge, DER canónico, clave y fingerprint originales, firma válida, identidad y empresa activas y autoridad actual del invitador. La recuperación funciona aunque haya vencido el TTL de la invitación; no duplica filas ni auditoría.
- Heartbeat/canal firmado `{version:1,method,path,company_id,host_id,issued_at,nonce,payload}`, ventana ±120s y antireplay transaccional. `HostEnrollmentRepository.request(host,method,path,packet,work)` verifica identidad y consume nonce en la misma transacción de la mutación. Un rechazo revierte el nonce. La función SQL nueva y restringida `cauce_lock_host_company` bloquea la empresa activa sin conceder UPDATE sobre empresas al runtime.
- POST `/v3/fleet/hosts/:host_id/channel`: comando discriminado estricto para operaciones de flota, cuotas y capacidades. Rechaza cookies, shell/comandos arbitrarios y firmas alteradas. El servidor deriva worker desde la identidad. Flota reconstruye fence durable host+empresa+token+epoch; cuotas verifica environment+token+epoch+worker+host+empresa. Repositorios reutilizan la transacción exterior.
- Snapshots firmados de ejecución limitados al host y empresa verificados; perfiles y cuentas sin credenciales, baseline durable y slice sellado. Operaciones agrupadas legacy conservan el snapshot de su empresa para el artefacto común del coordinador; operaciones individuales legacy también filtran por host.
- Catálogo declarado por el host con firma: versión executor, hash de política, flags de flota/cuotas, providers de cuotas y templates cerrados de runtime. No acepta comandos ni shell del navegador. Readiness vence a120s; heartbeat aislado no lo concede. El fallback central excluye toda identidad inscrita, incluso deshabilitada o vencida. Un refresco idéntico no duplica auditoría. Preview/enqueue vuelven a resolver autoridad durable, frescura y matching exacto del catálogo.
- Integración de exports/rutas de cuotas y contextos; selector `/v3/accounts/selection` admite `model` opcional limitado a128 caracteres. Hooks legacy de perfil/documentos sincronizan versiones. ACK de `recordContextAdoptionInTransaction` se ejecuta sólo tras fencing y transición done, con evidencia de consumo validada.
- Executor de flota: comprueba abort después de lecturas/mutaciones asíncronas y antes de settle; espera la renovación SQL pendiente al apagar. Pruebas diferidas independientes de cronometraje acreditan ambas carreras.

## Evidencia

PostgreSQL16 hermético proporcionado por el proceso principal. Antes de Vitest se carga el entorno privado de prueba; `CAUCE_TEST_RUNTIME_ROLE=1` mantiene las pruebas de negocio bajo los permisos reales de aplicación. Triggers de fallo intencional y preparación de políticas SQL usan la conexión administrativa del fixture, sin ampliar permisos runtime.

```text
company-registration-office: 8 passed
company-administration-enrollment: 8 passed
companies-configuration: 12 passed
companies-fleet: 10 passed
companies-people-admin: 14 passed
companies-revisions: 5 passed
fleet-hosts: 12 passed
password-auth-company: 16 passed
people-admin-store: 13 passed
operations-company: 2 passed
auth-main: 4 passed
host-channel.routes: 7 passed
fleet-operations-postgres: 31 passed
executor: 8 passed
fleet-hosts.routes: 15 passed
fleet-operations.routes: 47 passed
agent-profile-postgres: 46 passed
host-channel.executor: 1 passed
```

El ensayo HTTP real ejecuta Fastify local, identidad Ed25519 privada, SignedHostChannel, FleetExecutor y helper Python cerrado: detiene por SIGTERM un proceso Node creado exclusivamente por el test, escribe y relee un artefacto con SHA256 real, confirma `succeeded` y agente disabled/draft en PostgreSQL y verifica que un segundo ciclo no repite stop ni escritura. Demuestra transporte y efecto físico local; no acredita alta/auth de un proveedor externo.

Recibos de esta ampliación:

- `directorio temporal compartido/cauce-v4-task1-runtime-channel.log`: canal7, auth-main4, administración/enrolamiento8, 19/19.
- `directorio temporal compartido/cauce-v4-task1-final-worker-routes.log`: executor8 y rutas15+47, 70/70.
- `directorio temporal compartido/cauce-v4-task1-final-profile-executor.log`: perfil46, executor8 y ensayo HTTP1, 55/55.
- `directorio temporal compartido/cauce-v4-task1-final-consolidated.log`: flota PostgreSQL31, canal7, administración/enrolamiento8, hosts15, operaciones47 y configuración4; 6 archivos, 112/112.
- `directorio temporal compartido/cauce-v4-task1-final-typecheck.log`: `pnpm exec tsc --noEmit -p tsconfig.json`, salida vacía/exit0.
- `directorio temporal compartido/cauce-v4-task1-final-lint-fixed.log` y `final-strict-fixed.log`: eslint focal y estricto, salida vacía/exit0. Fixtures de perfil tienen recibos separados `final-profile-lint.log` y `final-profile-strict.log`.
- Corridas previas preservadas: `executor-refactor` conserva 31/31 de flota y el fallo real del parser prepare; `final-routes` conserva los fallos de fixtures que motivaron la corrección. No se sustituyeron sus resultados por PASS.

Revisión independiente de las APIs/store/adopción de contextos: no se encontró un fallo bloqueante confirmado en empresa, CAS, restore, límites de contenido, lease de aplicación y ACK done con hashes coincidentes. Conserva el límite explícito: `native_document:none` proyecta prompt/perfil SQL y no demuestra reescritura física de AGENTS/CLAUDE legacy. La revisión del broker de cuotas detectó fuga de mapping histórico, cohorte retenida al rechazar TTL y exceso de32 eventos; el proceso principal aplicó las reparaciones. Sus recibos y ensayo pertenecen a ese frente.

Quedan fuera de esta evidencia el gate global, la aceptación de proveedores externos, la creación Docker de una computadora nueva, una respuesta de proveedor publicada y cualquier despliegue. La revisión final, los commits y la publicación corresponden al proceso principal.
