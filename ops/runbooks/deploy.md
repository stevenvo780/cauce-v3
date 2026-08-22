# Runbook: deploy Cauce V3 aislado

## Preflight de release

1. Confirmar que el target, DB, DNS, collectors y unidades pertenecen a V3; no apuntar scripts a V2.
2. Construir runtime/consola con `make -C ops release-build` y publicar imágenes inmutables por digest.
3. Completar fuera del repo un env `0600` desde `ops/config/prod.env.example`. Son PATHs/config; el contenido sensible queda en archivos del gestor de secretos.
4. Ejecutar QA real, restart auténtico, `make -C ops smoke-cli` para los cinco
   ejecutables, restore drill y hashes. CLI smoke sigue siendo version/help-only.
5. Ejecutar `CAUCE_ENV_FILE=/etc/cauce-v3/prod.env make -C ops release-gate`.

El gate no tolera ausencia de Docker Compose v2 o `docker build`, build evidence viejo, SHA inválido, tests reales/restart skipped o fallidos, unidades systemd desactualizadas ni imagen sin `@sha256:`.

## Desarrollo y test

```sh
CAUCE_ENV_FILE=/ruta/privada/dev.env ops/scripts/compose.sh dev up --build -d --wait
ops/scripts/compose.sh test up --build --abort-on-container-exit --exit-code-from e2e
```

Dev (`deploy/compose.dev.yaml`) usa HTTP/WS y auth de desarrollo solo sobre bind loopback por defecto. Test (`ops/compose.test.yaml`) es efímero. Ninguno acredita producción TLS.

## Producción

`deploy/compose.yaml` no contiene `build:` ni PostgreSQL local. Usa una DB administrada cuyo `DATABASE_URL` se monta como secret y debe incluir `sslmode=verify-full` más CA. Para una DB autocontenida con TLS real:

```sh
CAUCE_LOCAL_POSTGRES=1 CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
  ops/scripts/compose.sh prod up -d --no-build --wait
```

El certificado del overlay debe tener SAN `postgres`; password/cert/key/CA se montan como secrets y `5432` no se publica.

### TLS/auth

- Gateway escucha HTTPS `8443`; health usa `https://gateway:8443` y CA montada.
- Consola escucha HTTPS `8444`, verifica el certificado upstream y presenta client cert. CSP mantiene scripts self-only y habilita solo atributos de estilo que xterm necesita.
- Los certificados internos deben incluir SAN `gateway` y `console` respectivamente;
  no desactivar hostname verification para acomodar certificados incorrectos.
- Elegir `oidc`, `mtls` o `token-file`; auth incompleta falla cerrado. `CAUCE_DEV_AUTH=0` es fijo.
- Exposición host usa `CAUCE_PRIVATE_BIND_IP` (default `127.0.0.1`); un balanceador público es un cambio externo explícito.
- Adapters no corren en el compose: se generan por alias, requieren WSS y secretos por PATH. Seguir `alias-cutover.md`.
- Gateway y dispatcher reciben el mismo `CAUCE_ACK_DEADLINE_MS` (default productivo explícito: `600000`). `ACK_TIMEOUT_MS` debe ser igual o mayor; ambos procesos fallan al arrancar ante valores no enteros/positivos o si el dispatcher pudiera reintentar antes del deadline. Un ACK `started` nuevo y correctamente fenced renueva `ack_deadline_at` y `claim_expires_at`; su replay exacto previamente aplicado vuelve a renovar sólo mientras claim y lease sigan vivos. Colisiones de `event_id`, ACK rechazados, claims vencidos y owners obsoletos no pueden renovarlos.
- `ack_deadline_at` es una lease corta de ownership, no el límite de ejecución
  del modelo. Mientras el harness sigue activo, el adapter emite ACK `started`
  durables y el gateway renueva la lease configurada; una caída sigue siendo
  detectable al vencer la última renovación. Todos los harnesses agentic usan
  `86400000` (24 h) por defecto y admiten overrides entre `60000` y
  `604800000` (7 días).

### Relay, Telegram, shadow y observabilidad

Profiles opt-in: `origin-relay`, `telegram`, `shadow`, `observability`. `telegram` ejecuta el bridge nativo y requiere un directorio externo read-only con `config.json`, tokens `0600` y markers de poller V2 detenido. `shadow` ejecuta el router por Unix socket y el guard; en shadow/compare no habilita harness ni respuesta humana, y cutover exige interlock/dirección. `origin-relay` no debe registrar `telegram` cuando el bridge está activo. Prometheus scrapea dispatcher, relay y `outbox-metrics`; wake/outbox/relay y DLQ tienen alertas.

Todos los procesos propios corren non-root, filesystem read-only, `no-new-privileges`, capabilities vacías y restart `always` (migrator es one-shot). No relajar health o TLS para forzar un arranque.

## Desplegar SÓLO la consola

`release-build.sh` construye siempre las dos imágenes y `release-gate.sh` exige que los dos digests
coincidan con esa evidencia, así que una corrección de pantalla arrastraba al runtime entero. El
camino solo-consola está en `ops/scripts/release-console.sh` (`make -C ops release-console`):
construye `--target console`, transfiere la imagen por SSH, **respalda** `/etc/cauce-v3/prod.env`
antes de tocarlo, pinea `CAUCE_CONSOLE_IMAGE` por digest con escritura atómica y validada, recrea
sólo el servicio `console` con `--no-deps` (gateway, dispatcher y outbox no se reinician, ninguna
entrega en vuelo se pierde) y **verifica por efecto**: que el contenedor corra el digest pineado,
que el bundle servido contenga la vista y que la consola conteste 200 con TLS. Si la verificación
falla, revierte sola. La vuelta atrás manual es `release-console.sh revertir`, y
`release-console.sh verificar` dice qué está sirviendo ahora sin cambiar nada.

La consola desplegada vive hoy en una rama que no está en `main`: leer
`runbooks/consola-rama-fuera-de-main.md` antes de construirla desde `main`.

## Gate posterior

`stack-health.sh prod`, migrations completas, consumer único por alias, lease owner único, round-trip ACK auténtico, wake/outbox/relay bajo umbral, DLQ cero y dos ventanas de retry estables. Cutover usa confirmación explícita y jamás se ejecuta como parte de deploy.
