# CLI de plataforma y transferencia de configuración por empresa

## Resultado y alcance

Implementación en el checkout aislado `codex/v4-complete`, sin commits propios ni intervención en producción. La CLI autentica la contraseña actual y mantiene la fila de credenciales y la autoridad humana bloqueadas en la misma transacción que las escrituras. La empresa de actuación es explícita y debe seguir activa. `is_hub`, un argumento de rol o la identidad de un agente no conceden autoridad de plataforma.

El catálogo global de harnesses y políticas de roles tiene una entrada exclusiva para humanos `platform_admin` durables. Reutiliza `ConfigurationRepository`: CAS, inversa, historial y auditoría humana. El editor genérico continúa prohibiendo ambos recursos. Las políticas no pueden dejar sin controlador cualificado a la plataforma ni a los propietarios de empresas.

La transferencia lleva sólo configuración estructural permitida: tenants, salas, metadatos de agentes, membresías y ACL internas. El formato versionado incluye versión de esquema y SHA256 canónico. El plan liga empresa, bundle, revisión CAS, mutations y solicitudes físicas con otro SHA256. La aplicación recalcula el plan y rechaza contenido alterado, colisiones de tenants ajenos, versiones incompatibles o revisiones obsoletas.

Se restaura mediante creación o actualización en la misma empresa, sin borrar recursos adicionales. No crea empresas ni identidades humanas. Una repetición del bundle y plan aceptados devuelve el recibo durable sin pisar ediciones posteriores. Un import idéntico no genera revisiones de configuración ficticias; el recibo queda en `audit_events`.

Los agentes nuevos nacen como borradores inactivos. Los cambios físicos y las membresías de agentes colocados pasan por `FleetOperationsRepository.forCompany(...).forTransaction(...)`, con identidad humana real y coordinador configurado. Las operaciones quedan en cola y se someten al fencing y la revalidación durable existentes. Las selecciones de cuenta, modelo y esfuerzo de un agente existente se conservan desde su fila local autorizada y se revalida el consentimiento del pagador; no se transportan en el bundle.

## Archivos entregados

- `packages/store/src/configuration-platform.ts`: autoridad humana, catálogo global y recuperación del último controlador.
- `packages/store/src/company-transfer-model.ts`: allowlist estricta, identidad, checksums y contratos.
- `packages/store/src/company-transfer-snapshot.ts`: export filtrado por empresa, sin secretos y con descriptor nativo conservado.
- `packages/store/src/company-transfer-plan.ts`: diferencias, CAS y separación de membresías físicas.
- `packages/store/src/company-transfer.ts`: transacción, savepoints, historial, recibo idempotente y cola física.
- `services/gateway/src/platform-cli.ts`: autenticación actual y ejecución dentro de la misma transacción.
- `services/gateway/src/platform-cli-arguments.ts` y `platform-cli-main.ts`: entrada local, archivos privados, prompt sin eco, límites y errores sin DSN ni stack.
- Pruebas nuevas en `company-transfer-model.test.ts`, `platform-cli-arguments.test.ts` y `platform-company-transfer-postgres.test.ts`.

Root integra los exports, scripts, wrapper `cauce platform`, installer y publicación. Cuotas implementó y verificó el contrato de empresa seleccionada de flota y el helper que lee su configuración real. Core realizó la revisión independiente de este sector.

## Uso y permisos

Todos los comandos exigen `--email`, `--company` y `--database-url-file` explícitos. No hay fallback a `DATABASE_URL`. La contraseña actual procede del prompt sin eco o de `CAUCE_PLATFORM_PASSWORD`; esta variable se elimina antes de crear el pool. Se rechazan contraseña, rol y DSN como argumentos.

```text
cauce platform show --email CORREO --company EMPRESA --database-url-file /ruta/privada/dsn
cauce platform change ... --mutation-file /ruta/privada/mutation.json --expected-revision N --dry-run|--apply
cauce platform rollback ... --revision N --expected-revision N --dry-run|--apply
cauce platform export ... --output /ruta/nueva/bundle.json
cauce platform plan-import ... --bundle-file /ruta/privada/bundle.json --expected-revision N --output /ruta/nueva/plan.json
cauce platform import ... --bundle-file /ruta/privada/bundle.json --plan-file /ruta/privada/plan.json --dry-run|--apply
```

Las entradas son archivos regulares, absolutos, privados del usuario actual, sin symlink final. DSN máximo 16 KiB; JSON máximo 32 MiB. Las salidas se crean con `O_EXCL`, `O_NOFOLLOW` y modo `0600`; no sobrescriben archivos existentes. El pool mantiene la política TLS de `createPool` en producción. El catálogo necesita un DSN autorizado con permisos de administración de plataforma; no se ampliaron privilegios SQL del runtime.

## Evidencia final

```text
pnpm exec vitest run packages/store/src/company-transfer-model.test.ts services/gateway/src/platform-cli-arguments.test.ts
Test Files  2 passed (2)
     Tests  10 passed (10)

pnpm exec vitest run packages/store/test/platform-company-transfer-postgres.test.ts --testTimeout=120000
Test Files  1 passed (1)
     Tests  13 passed (13)
  Duration  16.34s
```

PostgreSQL corrió únicamente contra la base desechable autorizada. El caso 13 ejecutó realmente `node --import tsx services/gateway/src/platform-cli-main.ts` con DSN temporal privado y contraseña actual sintética: `show`, preview de cambio, export con modo `0600`, generación del plan, import aplicado y replay. No imprimió contraseña ni DSN. Limpió sus archivos al terminar.

La suite demuestra autoridad y revocación, prohibición del catálogo en GUI/runtime, CAS e inversa, auditoría humana, recuperación del último administrador, aislamiento de Praxis, checksum y allowlist, rechazo de colisiones y planes alterados, noops, replay que conserva ediciones posteriores, descriptor nativo, borrador inactivo con una operación en cola y preservación de la selección local de proveedor en actualizaciones físicas.

La prueba de transacción enlazada capturó dentro de una transacción externa tanto un preview como un fallo después de crear una sala: ambos dejaron cero salas/revisiones y la transacción externa siguió utilizable. Esto acredita que los savepoints no convierten previews o errores capturados en cambios persistentes.

Verificaciones estáticas finales: `pnpm exec tsc --noEmit -p tsconfig.json` terminó con exit 0; ESLint de todos los nuevos archivos del sector terminó con exit 0; `node scripts/calidad.mjs` devolvió `calidad: VERDE (2666 ficheros; trinquete: 19 >800, 11 con fechas, 1130 con comentarios acotados)`. Los avisos de trinquetes antiguos no cambiaron el resultado ni motivaron modificación del baseline.

## Resultados negativos conservados y revisión

La primera corrida PostgreSQL dio 12/13: la membresía de un agente colocado fue correctamente rechazada por la guardia del editor genérico. Se corrigió el plan para enviarla únicamente por el descriptor físico. La segunda dio 12/13 porque el fixture colocado omitía `systemd_user`, requerido por la guardia de flota; se completó con la normalización real `stev`, sin relajar la guardia. La tercera pasó 13/13.

Core encontró dos problemas funcionales en la revisión independiente: export nativo perdido por el sentinel `host:<id>` y posible borrado de la selección local de cuenta/modelo/esfuerzo. Ambos se corrigieron y recibieron sus pruebas PostgreSQL. La lectura posterior de Core no encontró otro bloqueo confirmado. El primer intento unitario usó un nombre de proyecto Vitest inexistente; la ejecución correcta posterior pasó 10/10.

## Límites

No se exportan cuentas o bindings de proveedor, credenciales, contraseñas, certificados, OAuth, sesiones, personas, mensajes ni perfiles/contextos que requieren ACK de runtime. No es un backup integral de datos ni una clonación entre empresas. Los agentes sin descriptor físico completo se exportan como metadatos; requieren configuración física explícita antes de su activación. El import no relocaliza hosts.

Una operación en cola no acredita creación ni autenticación física. Los recibos declaran `physical_effect_verified:false`. No se ejecutó login externo, worker físico ni despliegue de producción en este tramo. Los gates completos, integración, release y efecto vivo corresponden a root.
