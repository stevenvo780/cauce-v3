# Task 4: consola V4

Estado: implementación en `console/**` verificada en el sector y revisada por el autor de cuotas; sin commits propios ni cambios en producción. Gates actuales del sector ejecutados y navegador local con mocks comprobado. Integración, gate global y E2E reales corresponden al coordinador.

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
- Backup del espacio: UI en Perfil y contexto, recibo durable acotado a empresa/tenant/alias/UUID, pending/running/failed/ready y descarga disponible sólo ready. El recibo admite hasta 1 GiB, igual que el backend. La descarga es un enlace al endpoint autenticado con la sesión: el navegador la escribe a disco en streaming y no carga el ZIP en memoria; la consola muestra el SHA-256 del recibo para que el usuario lo compare con el archivo descargado. El helper omite `.git` (declarado en el manifiesto como `vcs_metadata`: su config incluye URLs de remotos y hooks, y su almacén de objetos rompe el tope de entradas; el remoto es la fuente de verdad) y solo excluye por nombre credenciales reales (`.env*`, `*.pem`, `*.key`, `auth.json`, `credentials*.json`, `.npmrc`, ficheros de cookies de datos); código como `src/auth/login.ts` o `session.py` sí se incluye. Cambio de empresa, target, tenant o alcance de autorización invalidan las lecturas y la creación en curso y limpian el recibo; una descarga ya iniciada por el navegador no se puede abortar desde la consola, y el servidor la rechaza si la sesión ya no tiene permiso. La consola avisa de que los proyectos viajan sin `.git`, de que `.env` y credenciales se omiten y de cómo comparar el SHA-256 (`sha256sum archivo.zip`). `tenant_operator` consume sólo `home_tenant` explícito de la sesión; nunca infiere tenant del email. `running` admite hashes/tamaño completos de begin pero mantiene URL nula. `LIMIT_EXCEEDED` muestra fallo explícito y nunca ofrece copia parcial. Las rutas backend ya existen, se cotejó el contrato con core y se leyó su evidencia de ejecución aislada; el efecto publicado queda pendiente del coordinador.

## Evidencia local ejecutada

Gates actuales de consola, incluida la nueva ola de backup:

```text
pnpm --filter @cauce/console typecheck
$ tsc -b --pretty false
exit 0

pnpm --filter @cauce/console lint
$ eslint . --max-warnings 0
exit 0

pnpm --filter @cauce/console exec vitest run --reporter=dot
Test Files 283 passed (283)
Tests 2904 passed (2904)
Duration 62.68s
exit 0

pnpm --filter @cauce/console build
tsc -b && vite build
✓ built in 5.65s
exit 0

git diff --check -- console
exit 0
```

Foco de capacidades/broker: 5 archivos, 32 pruebas, exit 0. Logs: `/tmp/cauce-v4-console-auth.log`, `/tmp/cauce-v4-console-host-capabilities.log`, `/tmp/cauce-v4-console-typecheck.log`, `/tmp/cauce-v4-console-lint.log`.

Se corrigió el build fallido por import del barrel Node del protocolo: el dueño del protocolo añadió `@cauce/protocol/quotas` y la consola importa ese subpath, sin shim de Node. El fallo anterior de `node:crypto/createHash` no se oculta y no acredita el build actual.

Logs actuales: `/tmp/cauce-v4-console-backup-final.log`, `/tmp/cauce-v4-console-backup-build.log`, `/tmp/cauce-v4-console-backup-typecheck.log`, `/tmp/cauce-v4-console-backup-lint.log`. Las pruebas de consola son unitarias/UI/contrato con MSW y jsdom. No prueban proveedores, terminal de autenticación ni Docker remoto. La suite final tiene avisos MSW históricos por `/v3/console/mcp/client-delegations` y una lectura de mensaje; no hay fallos. El build advierte un chunk mayor de 500 kB. Los logs anteriores `/tmp/cauce-v4-console-final.log` y `/tmp/cauce-v4-console-build.log` quedan como evidencia del alcance previo; no acreditaban la ola de backup.

Backup: foco vigente de 5 archivos/29 pruebas, exit 0 (`/tmp/cauce-v4-console-backup-review.log`): DTO/ruta/metadata pending-running-ready-failed, límite de stream, CSRF, idempotencia, integridad MIME/tamaño/SHA, revocación durante el cuerpo, roles con email y `home_tenant`, sondeo y fallo explícito de tamaño. Typecheck/lint/build y suite completa actuales incorporan el guard `running`; revisión independiente final recibida sin hallazgos bloqueantes.

## Navegador local

Consola Vite aislada en `http://127.0.0.1:5195`, con el indicador MOCK API visible. Chromium Playwright, escritorio 1440×1000 y móvil 390×844.

- Mis cuotas: fijación vía PUT con CAS; cambiar Humanizar → Praxis oculta la tarjeta de Humanizar y mantiene Praxis sin fijar; volver conserva la fijación de Humanizar. Resultados `crossCompanyHidden=true`, `unpinnedInSecondCompany=true`, `pinSurvivesCompanySwitch=true`, `mobileOverflow=false`.
- Plano: salas/agentes derivados de topología de demostración, selección de sala, creación de parte «Mesa de equipo», PUT/GET con CAS y aviso de guardado tras relectura. `partSavedInFixture=true`, desbordamiento global de escritorio/móvil `false`; el lienzo mantiene desplazamiento interno para mapas amplios.
- Capturas revisadas: `/tmp/cauce-v4-quotas-desktop.png`, `/tmp/cauce-v4-quotas-mobile.png`, `/tmp/cauce-v4-office-desktop.png`, `/tmp/cauce-v4-office-mobile.png`, `/tmp/cauce-v4-office-editor-desktop.png`, `/tmp/cauce-v4-office-editor-mobile.png`.
- QA actual de cuotas/capacidades: `modelDependentVisible=true`, `noGlobalExhaustion=true`, `incompatibleHostCleared=true`, `createDisabled=true`, `queryEnabled=true`, `authDisabled=true`; Codex muestra sólo GPT Host y Claude sólo Claude Host. `desktopOverflow=false`, `mobileOverflow=false`. Capturas revisadas: `/tmp/cauce-v4-capabilities-desktop.png`, `/tmp/cauce-v4-capabilities-mobile.png`.
- Backup: POST 202 con CSRF e idempotency_key, pending sin botón de descarga, sondeo GET hasta ready y descarga de ZIP fixture de 22 bytes. Nombre `space-kant-00000000-0000-4000-8000-000000000050.zip`; SHA-256 real `8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85`. `pendingNoDownload=true`, `failedNoDownload=true`, `ownEnabled=true`, `foreignDisabled=true`, `missingDisabled=true`; sin desbordamiento global en escritorio/móvil. Capturas revisadas `/tmp/cauce-v4-backup-desktop.png` y `/tmp/cauce-v4-backup-mobile.png`. El ZIP vacío sólo verifica la mecánica/integridad de descarga de la UI; no contiene export de un espacio real ni acredita el manifiesto del backend.

Este ensayo comprueba interacción/layout con handlers MSW. Las dos empresas y la persistencia de ese ensayo son fixtures de QA; no acreditan aislamiento ni persistencia PostgreSQL publicados.

## Límites comunicados al coordinador

- El coordinador conecta el broker real al endpoint de scope y terminal de proveedor. La UI ya consume ese contrato, con pruebas MSW de scope y verificación; no se ha autenticado una cuenta real desde ella. awaiting_auth conserva su significado pendiente, separado de identidad funcional verificada.
- Las escrituras antiguas de perfil/directiva/documentos nativos requieren enlazarse al nuevo historial/outbox; el autor de contextos y el coordinador recibieron el requisito. El nuevo panel no acredita que esas vías ya estén sincronizadas.
- Aplicación remota/Git sin sink configurado devuelve error o estado pendiente, que la UI mantiene explícito. Aún no se ha ejecutado E2E contra backend real/publicado.
- La UI de enrolamiento está conectada al contrato final; claim/heartbeat firmados y prueba de un ordenador externo corresponden al coordinador, no a estas fixtures.
- Revisión independiente y gates finales del SHA integrado/publicado pendientes. Typecheck/lint/build/suite de este sector no sustituyen el gate global ni E2E del despliegue.

## Revisiones independientes para el coordinador

- El autor de cuotas revisó los guards, límites de formularios, awaiting_auth y estado model_dependent sin nuevos hallazgos; la nueva revisión de DTO/host/provider también quedó sin hallazgos. Revisó el panel de broker y pidió comprobar profile_id contra account_id: guard y prueba negativa añadidos, confirmación independiente final recibida sin pendientes de ese alcance. Esa revisión no acredita autenticación física.
- Backup: el revisor identificó inferencia inválida de tenant desde el email y ausencia de `LIMIT_EXCEEDED`. Ambas corregidas; root emite `home_tenant` en PasswordAuthProvider y la consola sólo usa ese dato. Revisión independiente final confirma contrato running/ready, errores explícitos y 29/29 pruebas sin nuevos bloqueantes. La revisión es de UI/cliente.
- Evidencia backend de core leída, sin reejecutar ni editar su sector: `/var/tmp/cauce-v4-space-backup-postgres.log` acredita 11/11 pruebas con PostgreSQL aislado, Fastify TCP, SignedHostChannel Ed25519, helper Python y descarga ZIP con sesión humana. `/var/tmp/cauce-v4-space-backup-python.log`: 7/7; `/var/tmp/cauce-v4-space-backup-host-unit.log`: 5/5. Se verifican hash, exclusión de secretos, fencing/replay, permisos, tamaño, expiración y límite durable. Es un ensayo con recursos sintéticos aislados; no acredita un backup publicado de un workspace real ni proveedor externo.
- Revisión read-only de signed-source/enrolled-main/worker/main: foco conjunto de 3 archivos/34 pruebas de canal firmado, worker y configuración de main, exit 0. El modo enrolled toma identidad privada y no abre pool ni usa credenciales PostgreSQL; el canal firma con Ed25519, limita cuerpos y respuestas y sanitiza errores.
- Dos carreras reproducidas y comunicadas al autor: lectura final de execution confirmaba settle después de shutdown, y shutdown retornaba con una renovación pendiente. El autor corrigió executor; reejecución independiente actual: `settledAfterShutdown=0`, `shutdownWaitedForRenew=true`, `pendingRenewAfterShutdown=false`. No se editó su sector. Estas comprobaciones no prueban un ordenador remoto ni la autenticación física del modo enrolled.

## Checklist para ensayo real coordinado

- Registro en sesión aislada: POST register con persona/empresa sintéticas del ensayo; receipt de creación y login posterior por separado. Comprobar sesión company_owner, empresa/hub propios, contraseña ausente de storage y no conservarla tras el intento. Un conflicto de registro no debe iniciar sesión.
- Selector: dueño/operador/reader ven empresa y rol acreditados; sólo plataforma cambia empresa. Humanizar/Praxis deben ocultar tarjetas, personas, agentes y borradores ajenos aun con alias o salas homónimos; una respuesta atrasada del ámbito anterior no debe proyectarse.
- Oficina: crear una parte en una sala del ensayo, PUT CAS y GET de la versión confirmada; recarga y segunda sesión deben releer esa misma persistencia. Un reader no edita; 409 mantiene el borrador. Retirar una sala debe ocultarla en el plano sin reconstruirla desde datos antiguos.
- Preferencias: fijar cuenta y cambiar de empresa; volver y comprobar preferencia persistida por persona/empresa en otro navegador. Registrar cuenta sin agente debe conservar ventanas desconocidas hasta tener lectura real.
- Backup: POST 202 durable, observar worker pending/running/ready, descargar ZIP exacto con sesión actual y verificar hashes/manifiesto/entradas excluidas. Probar revocación y cambio de empresa durante fetch, expiración y host no disponible; nunca ofrecer descarga para failed ni interpretar que descargar restaura el espacio.
- Guardar HTTP receipts, versiones, hashes y capturas del ensayo. Mocks, health, ACK o test unitario no sustituyen el efecto publicado. Limpieza sólo de los recursos sintéticos del ensayo, por el coordinador.
