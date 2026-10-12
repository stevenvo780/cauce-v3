# Ordenadores: enrolar y preparar el executor

Un ordenador nuevo pasa por dos pasos, ambos sin el super-admin de plataforma.

## 1. Enrolar (identidad)

```bash
cauce hosts enroll --gateway https://<gateway> --invitation-stdin   # pegar la invitación JSON de la consola
```

Genera una identidad Ed25519 propia en `~/.local/state/cauce-v3/hosts/<empresa>/<host>/`. Solo da identidad y latido firmado.

## 2. Preparar el executor

```bash
cauce hosts setup --dry-run   # muestra qué haría, sin escribir nada
cauce hosts setup             # instala y arranca el servicio
cauce hosts status            # ¿está listo? (salida 0 = executor_ready, 3 = no listo)
```

`setup` usa la identidad enrolada (si hay más de una, `--identity-directory`). Pide al gateway, por el canal firmado del host, el **paquete de preparación** de la empresa y hace lo siguiente:

1. Verifica la firma Ed25519 del paquete y la fija en `setup-signer.json` junto a la identidad (primer uso); un firmante distinto después se rechaza. El paquete debe ser de este `company_id`/`host_id` y tener menos de una hora.
2. Descarga el release (`kind: release`, tar con `ops/cli/fleet-executor.py` y `services/gateway/dist/fleet/main.js`) comprobando tamaño y SHA-256 firmados; rechaza rutas absolutas, `..` y enlaces. Se extrae en `~/.local/share/cauce-v3/hosts/<empresa>/<host>/release/<sha256>/`.
3. Compone `executor-policy.json` (0600): identidad, usuario y raíces los fija el cliente (la política del paquete no puede sobrescribirlos); plantillas, hooks, transporte y bundles vienen del paquete, con `@release@`, `@install@` e `@identity@` sustituidos. El digest de cada bundle se recalcula sobre el release extraído.
4. Valida con `fleet-executor.py --capabilities`; si el executor rechaza la política, no arranca el servicio.
5. Instala la unidad de usuario `~/.config/systemd/user/cauce-v3-host-executor.service` (plantilla `ops/systemd/user/`), `enable --now`, y reinicia solo si cambió algo. Repetirlo es idempotente.

El servicio publica capacidades al gateway cada 30 s; la consola muestra `executor_ready` cuando la política tiene plantillas.

### Linger

Para que el servicio sobreviva al cierre de sesión (como el usuario `server` de Salva en server2), `setup` intenta `loginctl enable-linger`. Si no tiene permiso, avisa: `sudo loginctl enable-linger <usuario>`.

## Contrato del gateway (pendiente de implementar en el servidor)

`POST /v3/fleet/hosts/:host_id/setup` con paquete firmado del host y `{"action":"package"}` responde:

```json
{"package": {"version":1,"company_id":"…","host_id":"…","issued_at":1760000000000,
  "artifacts":[{"name":"release","kind":"release","url":"https://…","sha256":"<64 hex>","size":123}],
  "policy":{"container_templates":[],"profile_templates":[],"bundles":{},"hooks":{},"transport":{}}},
 "signature":"<base64 Ed25519 sobre JSON canónico de package>", "signer_public_key":"<base64 SPKI DER>"}
```

Hasta que el gateway sirva esa ruta, `setup` falla con «host request rejected (HTTP 404)» y no toca el ordenador.
