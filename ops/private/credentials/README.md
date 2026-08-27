# Credenciales operativas de la flota

Carpeta **ignorada por git** (salvo este README): copias de trabajo de las credenciales que los agentes necesitan para operar con autonomía real — mTLS, tokens, `.env`. Aquí NUNCA hay valores en git; el mapa de qué existe y dónde está la fuente productiva vive en `ops/private/CREDENTIAL-INVENTORY.local`.

## Reglas (ver también la regla de credenciales en `ordenes/00-PROTOCOLO.md`)

- **PROHIBIDO** para toda instancia/agente/subagente: borrar, mover, renombrar, vaciar o reescribir NADA aquí dentro. Esta carpeta no vive en git: borrar = pérdida total. No es "limpieza", no es "código muerto".
- Solo el dueño (o un script que él autorice explícitamente) añade, rota o retira ficheros.
- `/etc/cauce-v3/` sigue siendo la única fuente productiva (fila NADIE de la tabla de sectores); esta carpeta no la sustituye.
- Permisos: 700 en carpetas, 600 en ficheros. El .gitignore no protege del filesystem.

## Layout previsto (se puebla a demanda del dueño)

```
git/                 token de GitHub + notas de rotación
pki/                 copias de /etc/cauce-v3/pki (sin los .bak-* históricos)
gateway/             mtls_identities.json, token_hashes.json, claves oidc
telegram-runtime/    config.json + <alias>.token
tenants/<tenant>/    container-pki y .env por alias, agrupado por tenant
host-backup/         credenciales de respaldo hacia torre/NAS
```
