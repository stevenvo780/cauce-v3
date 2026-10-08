# Cauce V3.5: plan de administración completa desde la UI

> Para ejecución por agentes: usar `superpowers:subagent-driven-development` o `superpowers:executing-plans` por tarea, respetando sectores, un escritor por fichero y revisión independiente. Este documento propone trabajo; no acredita implementación ni autoriza integrar/desplegar.

**Objetivo:** crear, actualizar y eliminar agentes, grupos y configuración operativa desde la consola actual, incluyendo aprovisionamiento y autenticación verificados.
**Arquitectura:** conservar PostgreSQL y el motor versionado de configuración; añadir operaciones durables de flota ejecutadas por un ejecutor restringido del host, independiente del agente que se está creando. Separar estado deseado/aplicado y ofrecer formularios que consumen las autoridades actuales, con terminal sensible sólo cuando hace falta interacción.
**Tecnologías:** React 19/Vite, Fastify/TypeScript, PostgreSQL, Zod, xterm.js y herramientas de operación Python/shell existentes.
**Especificación y evidencia:** [auditoría y alcance V3.5](../../v3.5-auditoria-ui.md), base `08a788947238a49f1b953ae82c3b357c4760f499`; revisar ADR-005/006/009, `docs/arquitectura.md` y `ordenes/00-PROTOCOLO.md` antes de ejecutar.

## Restricciones globales

- Rama/checkout aislados, un escritor por sector, revisor distinto y sólo el principal commitea con pathspec; ningún merge ni despliegue sin autorización expresa del dueño.
- Mantener cookie HttpOnly, CSRF, RBAC, aislamiento de tenants, consentimiento del pagador, OCC, fencing y auditoría. Ningún secreto en payload de job, logs, diff, browser storage o transcript.
- La BD conserva la autoridad; artefactos de flota y contexto son derivados. La UI no escribe en el checkout montado, `/etc`, `/opt`, Docker ni systemd directamente.
- No editar migraciones existentes ni `*.patch`; cambios de esquema nuevos y sus suites se coordinan con el dueño. No copiar credenciales/sesiones ni cambiar propietarios, cuentas o proveedores automáticamente.
- Cada tarea publica PR revisable con gates/evidencia exactos; las capacidades se habilitan por canario después de demostrar su efecto. Documentación española, código inglés, sin GitHub Actions.

**Orden de ejecución:** 1 → 2 → 5 → 3 → 4 → 6 → 7. La UI/contratos de 3 y 4 pueden prepararse antes; su aceptación operativa espera autenticación segura y revocación de 5. La planificación no cambia esa dependencia.

## Condiciones que debe comprobar la revisión

1. Dos operadores o un reintento tras timeout no duplican agentes, tokens ni pasos: CAS e idempotencia; lo comprueban tareas 1, 2 y 3.
2. Crear un tenant, repetir un alias en otro tenant o asignar varias salas no rompe flota/identidad física: tarea 1.
3. Un agente inexistente o deshabilitado puede aprovisionarse y autenticarse sin recibir mensajes antes de estar listo: tareas 2, 3 y 5.
4. Eliminar con trabajos, perfil, OAuth revocado, PTY vivo o host caído conserva historia y muestra estado parcial real: tarea 4.
5. Login cancelado, arnés no soportado o configuración no aplicada conserva un estado seguro y no expone secretos: tareas 5 y 6.

## Tarea 1: contrato de administración y flota sin restricciones heredadas

**Ficheros:** modificar `packages/protocol/src/schemas/configuration.ts`, `packages/store/src/configuration.ts`, `packages/store/src/configuration/mutations.ts`, `ops/scripts/export-fleet-snapshot.py`, `ops/schemas/alias-manifest.schema.json` y los generadores consumidores; crear `docs/adr/010-ui-lifecycle.md`. Un responsable por sector; el ADR ratifica alcance, eliminación y privilegios antes de implementar.
**Interfaces:** conservar `POST /v3/console/config/changes` para cambios declarativos y recibos exactos; añadir capacidades por recurso/acción y previsualización de dependencias con revisión observada. Definir ubicación y sala primaria durables, con membresías adicionales independientes y clave física sin colisiones por tenant/alias.
- [ ] Añadir casos de tenant nuevo, mismo alias en dos tenants, dos salas para un agente, identidad de room global y overlay de un agente retirado; fijar resultado esperado sin editar constantes de código para el alta.
- [ ] Retirar enum de tenants del schema de manifiestos y presupuestos 1:1 del exportador; adaptar claves/nombres físicos, allowlists y generadores juntos, con compatibilidad de los alias actuales.
- [ ] Materializar artefactos operativos por revisión en un directorio de estado ajeno al repo; contrastar digest y schema/paridad contra BD, distinguir revisión aplicada de versión de código y adaptar G-SNAP sin rebajarlo.
- [ ] Verificar fixtures anteriores/nuevos, aislamiento y colisiones; `ops/scripts/validate.sh` más suites de exportador/generadores. Commitear por sector y documentar la transición.

## Tarea 2: operaciones durables y ejecutor de flota

**Ficheros nuevos:** `packages/protocol/src/fleet-operation.ts`, `packages/store/src/repository/fleet-operations.ts`, `services/gateway/src/console/fleet-operations.routes.ts`, `ops/cli/fleet-executor.py`; modificar `services/gateway/src/app.ts`. Esquema nuevo a coordinar; nunca modificar SQL aplicado.
**Interfaces propuestas:** `POST /v3/console/fleet/operations/preview`, `POST /v3/console/fleet/operations` → `202 {operation_id,status}`, `GET /v3/console/fleet/operations/:id`, `POST .../:id/resume|cancel`. Solicitud `{kind,target,expected_revision,idempotency_key,parameters}`; target discriminado `agent(tenant_id,alias)|room(tenant_id,room_id)|tenant(tenant_id)`; kinds `create|update|start|stop|retire|restore|purge`, combinaciones/argumentos estrictos por recurso y respuestas sin secretos.
- [ ] Escribir pruebas de clave repetida con payload idéntico/diferente, dos jobs para mismo destino/cohorte compartida, host caído y crash tras cada paso; exigir una operación y resultados verificables.
- [ ] Persistir actor, destino, revisiones, pasos, leases/fencing, dependencias, errores tipados y evidencias. El ejecutor reautoriza al reclamar/aplicar, serializa alias/cohortes y sólo ejecuta funciones/argumentos permitidos bajo el usuario declarado.
- [ ] Usar repositorio de operaciones específico: `jobs` actual no selecciona mediante una allowlist de kinds de flota y no es una cola física de provisionamiento. Reutilizar primitivas de claim/lease, sin entregar jobs de flota al dispatcher de mensajes.
- [ ] Cancelar detiene pasos nuevos y compensa sólo pasos reversibles, nunca promete revertir consumo externo/credenciales usadas; reanudar relee hechos antes de repetir. Verificar negativos de privilegio/tenant y ausencia de secretos; commit con evidencia.

## Tarea 3: crear y actualizar un agente hasta dejarlo operativo

**Ficheros:** modificar `console/src/features/config/{AgentRegistryCreate,AgentRegistryEditor,AgentSettings}.tsx`; crear `AgentLifecycleWizard.tsx` y `console/src/api/client/fleet-operations-client.ts`; adaptar `ops/cli/cauce-credenciales.lib.sh`, `ops/scripts/issue-alias-token.py` y la operación de tarea 2 sin envolver el CLI interactivo entero.
**Interfaces:** registro y membresías deseadas atómicos; estado `draft|provisioning|auth_pending|verifying|ready|failed|retiring|retired` separado de `enabled`. Bootstrap abre sólo la autoridad de preparación; cambios de arnés/ubicación/cuenta pasan por update operativo y validación de cohorte.
- [ ] Probar alta sin contenedor/PTY previos y crash después de emitir certificado/token: reanudar no emite duplicados y no habilita routing antes de validar.
- [ ] Asistente identidad/espacio → grupos/rol → cuenta principal y fallback → máquina/runtime → contexto → autenticar → verificar. Reusar editor de contexto; retirar el requisito de routing habilitado para su preparación autorizada.
- [ ] Completar generación, runtime, PKI, registro PTY y permisos mínimos previstos; credenciales existentes sólo se reutilizan con identidad/huella comprobadas, no se sobrescriben. Preservar cuentas separadas y usuarios nativos/Docker.
- [ ] «Listo» exige cuenta comprobada, hechos del runtime, perfil aplicado, hello/lease válido y mensaje de prueba con respuesta del agente; habilitar admisión mínima del canario para esa prueba y activar routing normal después. Commit con evidencia E2E aislada.

## Tarea 4: grupos y borrado completo con dependencias visibles

**Ficheros:** modificar `console/src/features/config/{CollectionTable,ConfigPage}.tsx`, `packages/store/src/configuration/mutations.ts` y `packages/store/src/configuration/mutations/tenants.ts`; crear `GroupEditor.tsx` y `RemovalDialog.tsx`; ampliar operaciones y suites en `packages/store/test/` y `tests/e2e/`.
**Interfaces:** «Pausar» ≠ «Eliminar de flota» ≠ «Borrar definitivamente». La eliminación retira la entidad operativa conservando clave/historia; purge sólo permite filas sin referencias, también históricas/revocadas. El dry-run explica qué requiere mover, drenar, cancelar, revocar o conservar.
- [ ] Probar sala vacía/usada, traslado de miembros, agente con perfil y grants OAuth, binding en cascada, PTY activo, turno en vuelo y host inaccesible; ninguna FK histórica ni evidencia se pierde.
- [ ] Añadir crear/renombrar/eliminar grupos y gestionar miembros desde formularios; retirada cierra nuevas admisiones, decide drenar/cancelar en `/queues`, cerca claims/leases, revoca bus/PTY/tickets/conexiones y confirma parada/aplicación física.
- [ ] Usar marca de retirada distinta de `enabled` en agente, sala y tenant; no exigir alias para operar una sala/tenant. Los aliases fuera de servicio no se recrean por residuos de manifiestos. Conservar `retiring/failed` cuando queda revocación pendiente y mostrar recuperación desde UI.
- [ ] Deshacer declarativo captura también relaciones en cascada; restaurar retiro físico es una nueva operación validada con credenciales vigentes. Verificar compensación y recibo incierto; commit con evidencia.

## Tarea 5: conectar cuentas y administrar personas desde UI

**Ficheros:** ampliar `console/src/features/accounts/`, `console/src/features/auth/`, `services/gateway/src/console-users.ts`, `services/gateway/src/terminal/authority.ts`, `services/terminal-relay/src/{session-limits,session-instance}.ts` y ejecutor. Añadir rutas tipadas de administración humana y autenticación con pruebas en sus sectores.
**Interfaces:** operación de conexión con cuenta/proveedor/host/usuario/perfil explícitos; sesión sensible de bootstrap con permiso propio, expiración y control exclusivo. Mantener distintos login humano, PKI Cauce, autorización OAuth y proveedor CLI; distinguir declaración OAuth y revocación real.
- [ ] Probar login exitoso/cancelado/expirado, host caído, parada del adapter no confirmada y cuenta incorrecta; no rotar si no se ha detenido el proceso que usa las credenciales.
- [ ] Preferir device-auth/OAuth; si hace falta PTY, ejecutar sólo el login permitido sin grabación ni scrollback persistente de entrada/salida sensible, sin usar `harness_rw` grabado. Auditar actor/destino/resultado, conservar controles de otras sesiones y no copiar `auth.json`.
- [ ] Administrar altas, rol/tenant, renovación y baja de personas; revocar sesiones/grants efectivos y no sólo declaraciones. Evitar retirar al último administrador y reevaluar permisos de jobs después de una baja.
- [ ] Verificar una llamada funcional al proveedor y su identidad autorizada antes de marcar autenticado; comprobar ausencia de secretos en logs/recordings/estado/export y recuperación segura del adapter; commit con evidencia.

## Tarea 6: cubrir los ajustes todavía dependientes de JSON o terminal

**Ficheros:** ampliar formularios en `console/src/features/config/`, mantener inventario de cuentas en `/accounts` y contexto en `features/live/`; añadir contrato de configuración efectiva en `packages/protocol/src/` y proyección por arnés en `packages/adapter-sdk/src/context/`/PTY, con gateway y store como autoridades.
**Interfaces:** modelo/esfuerzo, plantillas de rol, ACL/roles, topes de cadena, destinos, MCP/herramientas/skills y colocación usan revisiones deseadas/aplicadas y catálogo de capacidades soportadas. Las referencias de secreto nunca se convierten en contenido legible; keys inmutables se cambian mediante reemplazo/migración de identidad explícita.
- [ ] Enumerar cada campo editable de la matriz de auditoría y asignar formulario, permiso, validador y verificación efectiva; cada recurso sin acción explica el motivo. Mantener JSON avanzado sin exigirlo para operación normal y proteger el último hub/administrador recuperable.
- [ ] Probar cambios en caliente versus reinicio requerido, herramienta declarada versus permiso efectivo, revocación, arnés no soportado y perfil/manual con conflictos CAS; modificar sólo campos allowlisted y conservar bloques gestionados.
- [ ] Añadir pruebas de todos los formularios, adaptación/ACK real por arnés soportado y compensación de actualización; actualizar ayuda/documentación y commit con evidencia.

## Tarea 7: aceptación y publicación de V3.5

- [ ] En staging aislado, desde navegador autenticado: crear espacio/grupo/agente → autenticar → editar contexto/cuenta/modelo/permisos → intercambio real → mover/quitar miembro → eliminar grupo y agente; repetir con persona sin permisos y con dos operadores concurrentes.
- [ ] Ejecutar `pnpm typecheck && pnpm lint && pnpm test:unit`, `pnpm test`, `ops/scripts/validate.sh`, `pnpm qa:layout` y gates de release aplicables sobre el código exacto; ninguna suite omitida cuenta como verde. Mostrar resultado y recibos de runtime.
- [ ] Revisión independiente por sector; con autorización del dueño, canario en cada tipo de host/arnés utilizado, rollout gradual y rollback comprobado. Sólo entonces `version-3.5.md`, número de versión e HISTORIAL describen V3.5 publicada.
- [ ] Cierre: toda fila del alcance tiene operación visible o restricción justificada, ningún alta/baja requiere SQL o editar ficheros a mano, y toda operación incompleta muestra su recuperación. Automatizaciones nuevas quedan fuera; las cuentas/políticas existentes permanecen administrables.
