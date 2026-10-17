# Consola V4

## Implementado

- Registro público y login posterior; selector de empresa y rol resueltos por sesión; cambio de empresa invalida la generación de solicitudes y remonta recursos de la sesión.
- Administración de empresas y autoridad separada de personas; conserva CRUD de personas y revocación. Ningún permiso depende de `is_hub`: formularios y computadoras consumen capacidades company/platform del servidor.
- Mis cuotas independiente del inventario por agente: tarjetas fijables persistidas por persona/empresa, gráficas de ventanas reales, consumo compartido, fecha de consulta, reinicios opcionales y estados desconocido/error/antiguo distintos de agotamiento.
- Ventanas agotadas de un modelo usan «Varía por modelo» si no existe una ventana global agotada: no acreditan por sí solas agotamiento de todos los modelos ni del agente.
- CRUD de cuentas y entornos, acciones tipadas de autenticar/consultar/actualizar/eliminar; consentimiento antes de autenticar y confirmación antes de borrar. Las operaciones pendientes o esperando autorización conservan ese estado. La salida sólo proyecta campos públicos; no ofrece shell general.
- Capacidades por ordenador/proveedor obligatorias en los DTOs: create filtra ordenadores compatibles y neutraliza la selección al cambiar de cuenta; cada comando requiere la acción anunciada por ese ordenador y proveedor. Revalida la capacidad tras consentimiento; hosts retirados y awaiting_auth sin operación también bloquean comandos. La unión global no habilita un host concreto.
- Autenticación de cuotas conecta el scope del broker compartido al panel/terminal de proveedor; valida operación, cuenta, perfil, proveedor, ordenador, harness y usuario. Usa el claim_epoch entregado como expected_operation_version sin confundirlo con la versión del entorno. La relectura de cuentas conserva sesiones de login; verificación de identidad y error de relectura siguen estados distintos.
- Oficina conserva campus y terminales; plano de salas/partes editable con GET/PUT y CAS. Claves compuestas tenant/sala; deriva agentes y asignaciones de topología y descarta salas retiradas. Cuotas por agente y cansancio visibles en plano, tarjeta y ficha.
- Contextos: editor de archivos versionados, historial paginado, diferencias, restauración que crea versión, aplicación y reintento de sincronización; desired/applied/GitHub visibles por separado. Conflictos conservan el borrador.
- Enrolamiento: alta/listado/cancelación de invitaciones de ordenadores, receipt verificado y token de una sola entrega conservado sólo en memoria. Instrucción Cauce CLI por stdin; no pide SSH, contraseña ni clave privada. Identidad confirmada y ejecutor aprobado siguen estados separados.
- Lecturas de cuotas/contextos validadas antes de proyectar tarjetas; cuentas legadas conservan proveedor y usan id si el nombre es nulo. Personas de una empresa diferente no se proyectan como candidatas para asignar autoridad.
- Backup del espacio: Perfil solicita y consulta la copia; solo `ready` ofrece descarga autenticada. Cambio de empresa o de alcance limpia el recibo. `running` no ofrece URL y `LIMIT_EXCEEDED` se muestra como fallo. El contrato completo está en [copias durables](v4-copias-espacios.md).

## Operación y recuperación

- **Operación:** autenticarse en `/login` (`POST /v3/auth/login`), seleccionar la empresa activa cuando corresponda (`POST /v3/auth/session/company`), operar desde las vistas del menú (`console/src/nav.ts:53-112`) con previsualización o confirmación antes de mutar, y consultar el estado de cada operación durable o recibo antes de darla por terminada.
- **Recuperación:** ante errores de red, fallos `503` de relectura o conflictos `409` de revisión (CAS), la consola conserva el borrador abierto en memoria, bloquea el envío para impedir escrituras sobre datos obsoletos y muestra el botón de reintentar o recargar la versión vigente desde PostgreSQL ([estados de la consola](v4-consola-estados.md)). Si una operación de cuota o agente queda en `awaiting_auth`, completar el login del proveedor y reanudar la operación (`POST /v3/console/fleet/operations/:id/resume`).

## Evidencia

Las 13 suites E2E de navegador real V4 (`tests/e2e/v4-*-real-browser.test.ts`) ejecutan Chromium contra el gateway y PostgreSQL reales ([inventario de pruebas](v4-pruebas.md) y [matriz CRUD](v4-matriz-crud.md)). Los recibos adicionales y sus límites están en la [matriz de verificación](v4-matriz-local.md).

## Límites

- La autenticación de un proveedor externo comercial desde la UI requiere la cuenta real del proveedor en el host; `awaiting_auth` sigue siendo un estado pendiente, no una identidad verificada.
- Las suites locales de navegador acreditan persistencia en PostgreSQL efímero y gateway real, pero no sustituyen el humo autenticado tras publicar en producción.
- La identidad y presencia de un ordenador no demuestran que su executor esté preparado. El claim/heartbeat y el efecto físico requieren un host con `executor_ready: true`.

