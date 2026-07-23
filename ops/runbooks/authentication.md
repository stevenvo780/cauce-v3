# Runbook: autenticación productiva OIDC, mTLS y piloto por hash

## Invariantes

- `NODE_ENV=production` rechaza dev headers y exige TLS cert/key del gateway.
- Elegir un solo `CAUCE_AUTH_PROVIDER=oidc|mtls|token-file`.
- No colocar tokens, private keys, cookies ni Authorization en env versionado, logs o config JSON.
- Los identity files contienen solo digests SHA-256, principals y expiración; se montan read-only y se rotan atómicamente.

## OIDC

Configurar paths/URLs no secretos `CAUCE_OIDC_ISSUER`, `CAUCE_OIDC_AUDIENCE` y `CAUCE_OIDC_JWKS_URL=https://...`. El provider limita algoritmos, valida firma, issuer, audience, `exp/nbf` y claims de tenant/alias/session/channel/roles/permissions. JWKS no disponible falla cerrado.

## mTLS

Montar cert/key servidor, CA cliente y `CAUCE_MTLS_IDENTITY_FILE`. El listener exige certificado verificado por Node TLS; headers forwarded de certificados se ignoran. Formato del mapa (solo fingerprints):

```json
{"version":1,"identities":[{"certificate_sha256":"<64-hex>","expires_at":"2030-01-01T00:00:00Z","principal":{"tenant_id":"Steven","alias":"kant","session_id":"mtls-kant","channel":"adapter","roles":["operator"],"permissions":["route","read","control"]}}]}
```

## Piloto token-file

Montar `CAUCE_TOKEN_HASH_FILE`; jamás el token. Calcular el hash fuera del repo/host de CI y guardar solo `<64-hex>`. Browser usa cookie emitida por el autenticador `__Host-cauce_session; Secure; HttpOnly; SameSite=Strict; Path=/`. Un wrapper de adapter productivo puede presentar Bearer solo si su transporte lo implementa y se prueba auténticamente; los protocol doubles y el CLI bundled no acreditan esa capacidad. Presentar cookie y Bearer a la vez se rechaza.

```json
{"version":1,"identities":[{"token_sha256":"<64-hex>","expires_at":"2030-01-01T00:00:00Z","principal":{"tenant_id":"Steven","alias":"kant","session_id":"pilot-kant","channel":"console","roles":["operator"],"permissions":["route","read","control"]}}]}
```

Cada request relee el archivo: ausencia, JSON inválido, hash duplicado, expiración o principal inválido falla cerrado. Para revocar, reemplazar el archivo por rename atómico y verificar 401 con un token de prueba; no imprimir el valor.

## Gate

Verificar HTTPS, WSS de adapters, client cert/CA o Bearer auténtico, cookie attributes, Origin/same-origin CSRF, 401 negativos, principal sin spoof headers y rotación. Los manifests contienen nombres `*_PATH`, nunca valores. No aprobar producción con `sslmode=require` ni con health HTTP expuesto.
