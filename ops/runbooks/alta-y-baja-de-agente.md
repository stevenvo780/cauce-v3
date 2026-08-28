# Runbook: Alta y Baja de Agentes (Flota como Datos)

## 0. Principio y Regla de Verdad

La base de datos PostgreSQL (`agents` + `memberships`) es la **ÚNICA fuente de verdad**.
- **Prohibido editar a mano**: `ops/container-aliases.json`, `ops/manifests/*.yaml`, unidades systemd en `ops/generated/` o archivos de configuración derivados.
- **Cadena declarativa**: `BD -> export-fleet-snapshot.py -> ops/flota.json -> regenerate-fleet.sh -> validate.sh -> cauce aprovisionar/retirar`.
- **Invariante de `enabled`**:
  - `enabled = true` en BD -> el alias se ubica en el bloque `fleet` del snapshot y genera manifest y unit systemd activa.
  - `enabled = false` en BD -> el alias se ubica en el bloque `retired` del snapshot, purgando automáticamente manifest y unit.

---

## 1. Requisitos Previos

1. **Variables de entorno para emisión PKI y PTY**:
   ```sh
   export CAUCE_CLIENT_CA_CERT=/etc/cauce-v3/pki/ca.crt
   export CAUCE_CLIENT_CA_KEY=/etc/cauce-v3/pki/ca.key
   export CAUCE_PTY_MASTER_FILE=/etc/cauce-v3/secrets/pty_master.key
   ```
2. **Acceso a PostgreSQL**: conexión activa con permisos de inserción y actualización sobre las tablas `agents` y `memberships`.
3. **Herramientas requeridas**: `python3`, `openssl`, `flock`, `systemctl`, `docker`.

---

## 2. Flujo de ALTA (Onboarding)

### Paso 1: Inserción en Base de Datos (BD)

Ejecutar la inserción en `agents` y `memberships` dentro de una transacción:

```sql
BEGIN;

-- 1. Registro del agente
INSERT INTO agents (
  tenant_id,
  alias,
  harness_id,
  enabled,
  container_name,
  runtime_user,
  home_directory,
  state_directory
) VALUES (
  'Steven',                             -- Tenant: Steven | Miguel | Jhon | Isa
  'probeta',                            -- Alias único del agente
  'codex',                              -- Harness: claude | codex | openclaw | hermes | opencode
  true,                                 -- Habilitado
  'ctrl-infra',                         -- Contenedor Docker (o 'host:<hostname>' para agentes host-native)
  'dev',                                -- Usuario de ejecución dentro del contenedor/host
  '/home/dev',                          -- Home directory
  '/home/dev/.local/state/cauce-v3/probeta' -- Runtime state directory
);

-- 2. Membresía del agente en su sala
INSERT INTO memberships (
  tenant_id,
  alias,
  room_id,
  role,
  enabled
) VALUES (
  'Steven',
  'probeta',
  'grp.steven',                         -- Sala principal del tenant
  'operator',                           -- Rol: operator | agent | agent_notify | member
  true
);

COMMIT;
```

> **Nota sobre colocación física (`ops/flota-fisica.json`)**: Si el agente requiere colocación física no estándar (`dockerHost` distinto de `local`, `registryContainer` o `healthContainer` divergente), añadir la entrada en `ops/flota-fisica.json`. Para agentes estándar en contenedores locales, no se requiere editar `flota-fisica.json`.

---

### Paso 2: Exportar Snapshot Canónico

Generar el archivo canónico versionado `ops/flota.json` desde la base de datos:

```sh
python3 ops/scripts/export-fleet-snapshot.py --out ops/flota.json
```

- Inspeccionar el cambio con `git diff ops/flota.json`. Debe reflejar únicamente el nuevo alias bajo la clave `fleet`.
- El snapshot es determinista (sin marcas temporales, ordenado alfabéticamente por alias).

---

### Paso 3: Regenerar Artefactos de Flota

Ejecutar el script maestro de regeneración para derivar todos los artefactos dependientes:

```sh
./ops/scripts/regenerate-fleet.sh
```

Este comando actualiza y genera en orden:
1. `ops/container-aliases.json` (mapeo `schemaVersion: 2` de aliases y contenedores).
2. `ops/manifests/<alias>.yaml` (manifiesto declarativo del agente).
3. `ops/generated/fleet.json` (definición para watchdog e inspectores de `/opt`).
4. `ops/generated/systemd/cauce-v3-alias-<alias>.service` (unidad systemd de host).
5. `ops/generated/container-systemd/rootless/cauce-v3-container-<alias>.service` (unidad systemd de contenedor).
6. `ops/telegram-runtime/config.json` (configuración del puente de Telegram).

---

### Paso 4: Validar con el Gate

Ejecutar el gate de validación para garantizar la coherencia hermética byte a byte:

```sh
./ops/scripts/validate.sh
```

El gate verifica:
- Identidad estricta entre `ops/flota.json` y los archivos derivados.
- Esquemas JSON Schema y YAML válidos.
- Sintaxis correcta en todos los scripts y manifiestos.
- Checksums SHA256 actualizados en `SHA256SUMS` y `OPERATIONS.sha256`.

---

### Paso 5: Aprovisionar Credenciales del Agente

Ejecutar el comando de aprovisionamiento del CLI operativo:

```sh
# [no ejecutable en verificación]
ops/cli/cauce <alias> aprovisionar
```

El aprovisionamiento emite y publica de forma atómica (sin imprimir secretos en stdout) las siguientes 5 piezas:

1. **Certificado y Clave Cliente mTLS (`agent-<alias>.{crt,key}`)**:
   - Emisión vía OpenSSL contra la CA raíz (`CAUCE_CLIENT_CA_CERT` / `CAUCE_CLIENT_CA_KEY`).
   - Extensiones: `extendedKeyUsage = clientAuth`, `basicConstraints = critical,CA:FALSE`.
   - Permisos en destino: `0444` (cert) y `0400` (key), propiedad `1000:1000`.
   - Common Name (`CN=agent-<alias>`) validado contra la allowlist derivada de `ops/flota.json`.

2. **Bearer Token y Hash (`token_hashes.json` / `mtls_identities.json`)**:
   - Generación de token criptográfico aleatorio (`secrets.token_hex(32)`).
   - Archivo de token publicado en modo `0400`.
   - Cálculo de digest SHA-256 e inserción atómica con `flock` y rename CAS en `/etc/cauce-v3/secrets/identities/token_hashes.json` y `mtls_identities.json`.

3. **Clave de Terminal PTY (`alias-key.hex`)**:
   - Derivación HKDF mediante `ops/pty-agent/publish-alias-key.sh` usando el master secret `CAUCE_PTY_MASTER_FILE`.
   - Publicación en modo `0400` en el directorio PKI del alias para la autenticación en el terminal relay.

4. **PKI de Contenedor y Archivo de Entorno (`container-pki/<alias>/` y `<alias>.env`)**:
   - Creación del directorio `/etc/cauce-v3/container-pki/<alias>/` con certificados y token de acceso.
   - Creación y configuración de `/etc/cauce-v3/container-aliases/<alias>.env` con las rutas `CAUCE_<ALIAS>_*_PATH` e identificadores del arnés.

5. **Token de Bot de Telegram**:
   - Solicitud interactiva/configuración del bot token generado en BotFather.
   - Registro en `/etc/cauce-v3/telegram-runtime/config.json`.
   - Verificación de permisos `0600`, propiedad correcta y contenido no vacío.

---

### Paso 6: Verificación de Efecto Real

1. **Instalar e Iniciar la Unidad Systemd**:
   ```sh
   # [no ejecutable en verificación]
   systemctl --user daemon-reload
   systemctl --user enable --now cauce-v3-container-<alias>.service
   ```

2. **Comprobar Estado Activo de la Unidad**:
   ```sh
   # [no ejecutable en verificación]
   systemctl --user is-active cauce-v3-container-<alias>.service
   ```

3. **Verificar Lease de Conexión en Base de Datos**:
   ```sql
   SELECT alias, lease_until, lease_until > now() AS lease_activo
   FROM connection_leases
   WHERE alias = '<alias>';
   ```
   *Criterio de éxito*: Retorna 1 fila con `lease_activo = true`.

4. **Probar Mensaje Roundtrip en el Bus**:
   ```sh
   # [no ejecutable en verificación]
   ops/cli/cauce probar <alias>
   ```
   *Criterio de éxito*: Mensaje entregado y procesado con estado `done` y ACK durable registrado en PostgreSQL.

---

## 3. Flujo de BAJA / RETIRO (Offboarding)

### Paso 1: Retiro de Credenciales y Parada del Servicio

Ejecutar el comando de retiro del CLI operativo:

```sh
# [no ejecutable en verificación]
ops/cli/cauce <alias> retirar
```

Este paso ejecuta de forma atómica:
1. Detiene y deshabilita la unidad systemd del agente (`systemctl --user disable --now cauce-v3-container-<alias>.service` o de host).
2. Revoca el hash del token en `token_hashes.json` y `mtls_identities.json` mediante rename atómico con `flock`.

---

### Paso 2: Desactivación en Base de Datos

Marcar el agente como deshabilitado en PostgreSQL:

```sql
UPDATE agents
SET enabled = false
WHERE alias = '<alias>';
```

> **Efecto Inmediato**: `authority.ts` en el gateway consulta `agents` en vivo; cualquier intento de conexión subsiguiente será rechazado de inmediato a nivel de capa de autorización.

---

### Paso 3: Re-exportar Snapshot de Flota

Re-exportar el snapshot para reflejar el retiro:

```sh
python3 ops/scripts/export-fleet-snapshot.py --out ops/flota.json
```

- Al ejecutar `git diff ops/flota.json`, el `<alias>` se habrá movido automáticamente de `fleet` a `retired: { "<alias>": {} }`.

---

### Paso 4: Regenerar Flota y Purgar Artefactos

Ejecutar la regeneración para purgar los archivos huérfanos:

```sh
./ops/scripts/regenerate-fleet.sh
```

Efectos de la regeneración en baja:
- Elimina `ops/manifests/<alias>.yaml`.
- Elimina `ops/generated/systemd/cauce-v3-alias-<alias>.service`.
- Elimina `ops/generated/container-systemd/rootless/cauce-v3-container-<alias>.service`.
- Remueve el alias de `ops/container-aliases.json` y `ops/telegram-runtime/config.json`.

---

### Paso 5: Validar con el Gate

Confirmar que el árbol de trabajo está limpio y consistente:

```sh
./ops/scripts/validate.sh
```

*Criterio de éxito*: Salida en verde con todos los tests sintácticos, manifiestos y checksums aprobados.

---

### Paso 6: Verificación de Rechazo en Gateway

1. **Verificar Rechazo de Conexión**:
   Intentar una conexión WebSocket o HTTP hacia el gateway con las credenciales antiguas del agente.
   *Criterio de éxito*: El gateway responde con código HTTP `401 Unauthorized` o `403 Forbidden` y cierra la conexión.

2. **Verificar Ausencia de Leases Activos en BD**:
   ```sql
   SELECT alias, lease_until, lease_until > now() AS lease_activo
   FROM connection_leases
   WHERE alias = '<alias>';
   ```
   *Criterio de éxito*: Cero filas o `lease_activo = false`.

3. **Verificar Cese de Procesos**:
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/container-adapter-supervisor.sh stopped <alias>
   ```

---

## 4. Procedimiento de Reversión (Rollback)

Si se requiere revertir una baja errónea o fallida:
1. Re-habilitar en BD: `UPDATE agents SET enabled = true WHERE alias = '<alias>';`.
2. Exportar snapshot: `python3 ops/scripts/export-fleet-snapshot.py --out ops/flota.json`.
3. Regenerar artefactos: `./ops/scripts/regenerate-fleet.sh`.
4. Validar gate: `./ops/scripts/validate.sh`.
5. Re-aprovisionar credenciales si fueron revocadas: `ops/cli/cauce <alias> aprovisionar`.
6. Iniciar la unidad systemd del agente.
