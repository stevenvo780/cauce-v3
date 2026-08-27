# Handoff operativo — renovación durable del harness y ejercicio Prometeo

Última actualización verificada: `2026-07-25T08:50:00Z`.

> **AVISO — este documento quedó desactualizado dos veces.** Lo que la §0 declaraba
> desplegado (`842d42b`) fue superado por `9dfb79d` y luego por `7d4c154`, sin que nadie
> actualizara el texto. No confíes en el commit que diga: contrastá siempre contra
> `docker inspect` de los containers vivos. El estado vigente está en la §0.0.

## 0.0 ESTADO VIGENTE — 2026-07-25T08:50Z

```text
commit desplegado:  7d4c154f168f5910d8f08658409026c4f873d842
sourceDigest:       sha256:ea660e0c4f7afc11826ee525a2cbb13b616cc61c850bc1d3572dde929f5050b2
operationsDigest:   sha256:4ca79f32cb87c29087ff82aa75bbf5a68a4a9cf0aaafa563b247b9a9fbb69679

runtime:  127.0.0.1:5000/cauce-v3-runtime@sha256:5072c97c93924756af384400b96e52982cb97a8625e84875894a3eaae93f5dd7
console:  127.0.0.1:5000/cauce-v3-console@sha256:31557f3bf4f2d71cc677d3d21c4653b07f777b5eb431265fd3213b979c3a19c6

rollback: /opt/cauce-v3.previous-7d4c154f168f5910d8f08658409026c4f873d842
          /etc/cauce-v3/prod.env.pre-7d4c154f168f5910d8f08658409026c4f873d842
          /etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml.pre-7d4c154f...
          /opt/_archive/cauce-v3-releases/2026-07-25/pre-7d4c154f...
respaldo DB: /opt/_archive/cauce-v3-db-backups/cauce-20260725T083044Z.dump
```

Aporta visibilidad de cadena (migración 008) y egreso proactivo (009). `release gate
passed` con el candidato exacto, preflight del override Telegram con los tres composes
rindiendo el mismo runtime, migrador `exit=0`, los cinco servicios `healthy` con
`RestartCount=0`, 12 leases de agente y 12 del bridge vivas.

**El egreso proactivo está inerte por diseño y eso es correcto:** `allow_notify` nace en
`false` para todo rol y `egress_destinations` está vacía. Ningún alias puede notificar
hasta que exista una fila para su `(tenant, alias)`. Además `egress_contacts` **no tiene
backfill**: se llena con cada ingreso autenticado de aquí en adelante, así que un destino
con `require_prior_contact` se deniega hasta que esa persona vuelva a escribir. Sólo un
destino de **grupo** puede eximir el contacto previo.

**Sin verificar en producción:** el enrutado de grupos por mención, desplegado en
`9dfb79d`. Al 2026-07-25 **todas** las conversaciones registradas son `private` — ningún
bot recibió jamás un mensaje de grupo. Hace falta que un humano agregue un bot a un grupo
real y escriba mencionándolo.

**El gate depende de un host de 2 CPUs y eso lo vuelve una tirada de dados.** Ver
`ops/harness/authentic-runner.mjs`: el presupuesto de frame subió a 60 s en `7d4c154`
porque con 20 s fallaba al azar una u otra prueba de inyección de fallos. Verificado con
una corrida de control del candidato entonces vivo en producción, que perdió 2 de 6 igual.
Aun con 60 s hizo falta un segundo intento. Correrlo en una máquina con más CPU sigue
siendo lo recomendado.

Este documento es el punto de reanudación para otro harness. No asumir que una
configuración escrita ya fue aplicada a los containers: contrastar siempre
configuración deseada, imagen efectiva y estado de base de datos.

## 0. ESTADO ACTUAL — el rollout de §7 y §8 YA SE EJECUTÓ

Todo lo que las secciones 5 a 8 describen como pendiente está aplicado. Esas
secciones quedan como registro histórico del intento con `44f4b41`; los digests,
rutas y comandos que citan ya no son los vigentes. Lo vigente es esto:

```text
commit desplegado:      842d42bdd4027402a70d9aceeab32a11ee4f02c4
sourceDigest:           sha256:5a6cd37595f124b3cf9d4049e3ed55e28c21f855da083ae23dbb3ba97ec1b898
operationsDigest system:sha256:4ca79f32cb87c29087ff82aa75bbf5a68a4a9cf0aaafa563b247b9a9fbb69679

runtime:  127.0.0.1:5000/cauce-v3-runtime@sha256:212684f1fd374262cbddb9b1035ec9f90c537f22f149ac47b53e18b87f3d1687
console:  127.0.0.1:5000/cauce-v3-console@sha256:6567a7ffbd426e65c4f20a8013115fc6754b2f9615dfcd93cb2e7ed490b17c05

ops rootless: ~/.local/share/cauce-v3/releases/ops-842d42bdd402  (rollback: ops-480a611f94b0)
bundle:       bus-v3-20260725-renewal-842d42bdd402
bundle sha:   sha256:b99891879c5bf736b886e12de91b48d8e04647813d167cf98186eda626946451
```

Verificado tras el rollout:

- `release gate passed` con el candidato exacto, y preflight del override Telegram
  con los tres composes rindiendo el mismo runtime.
- gateway, dispatcher, outbox-metrics, telegram-bridge y console corren los
  digests de arriba, `healthy`, `RestartCount=0`.
- El split-brain de runtime se cerró: el hash del código de aplicación bajo `/app`
  es idéntico en gateway y telegram-bridge.
- Los 12 alias corren el bundle nuevo y **los 12 anuncian
  `renewable_delivery_claims_v1`**, con exactamente una lease cada uno.
- `CAUCE_DEFAULT_TIMEOUT_MS=86400000` efectivo dentro de los containers. Antes era
  540000 en cuatro alias y 300000 en los otros ocho.

Respaldos de este rollout, que no se deben sobrescribir:

```text
/opt/_archive/cauce-v3-releases/2026-07-25/pre-842d42bdd4027402a70d9aceeab32a11ee4f02c4
/etc/cauce-v3/prod.env.pre-842d42bdd4027402a70d9aceeab32a11ee4f02c4
/etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml.pre-842d42bdd4027402a70d9aceeab32a11ee4f02c4
/opt/cauce-v3.previous-842d42bdd4027402a70d9aceeab32a11ee4f02c4
```

### 0.1 Qué reparó el gate

`9d36aa7` y `842d42b` corrigen dos fixtures que no podían expresar un contexto sin
privilegios cuando el gate corre como root, sin relajar ningún rechazo productivo
de UID/GID 0:

- `container-supervisor.test.mjs` pasaba la identidad del propio proceso de test
  como identidad de runtime del adapter; bajo root era 0 y `child_credentials()`
  salía 78 antes del remapeo a 70.
- `container-cutover.test.mjs` expresaba «lock dir del sistema inutilizable» con
  modo `0555`, que root ignora por `CAP_DAC_OVERRIDE`, así que nunca tomaba el
  fallback a `XDG_RUNTIME_DIR`.

Ambas suites pasan ahora como usuario normal y como root real.

### 0.2 Pendiente conocido, no bloqueante

- `test-compose-authentic` es **flaky en el host de release**: sobre 4 corridas
  fallaron dos casos distintos, siempre por timeout. El host tiene 2 CPUs y
  `load average` ~5 con 21 containers. Cada caso pasó en al menos dos corridas y
  la corrida usada como evidencia fue 6/6. Subir los timeouts de
  `ops/harness/authentic-runner.mjs` o correr el gate en un host con más CPU.
- El bundle sólo es reproducible entre máquinas si se extrae con `umask 000` y
  `--same-permissions`: `bundle-digest` cubre los modos, y el umask 027 de kratos
  deja los directorios en `550` en vez de `555`.
- `pnpm deploy --prod --legacy` deja un symlink que escapa del bundle
  (`node_modules/.pnpm/node_modules/@cauce/adapter-sdk` → el workspace). Hay que
  borrarlo antes de calcular el digest o `bundle-digest` sale 78.
- La consola no autentica al usuario: `apps/console/nginx.conf` no tiene
  `ssl_verify_client`, así que cualquiera con ruta de red a `100.64.0.6:8444`
  opera con el certificado de cliente de la propia consola.

## 1. Objetivo y flujo que debe demostrarse

El trabajo del agente raíz es estabilizar Cauce V3. El trabajo funcional de
Prometeo no debe hacerlo el agente raíz: debe ejecutarse como ejercicio real de
orquestación:

```text
Steven → Jarvis → Argos → Sócrates
                         ↓
Steven ← Jarvis ← revisión independiente de Argos
```

Reglas del ejercicio:

- Jarvis delega una sola vez a Argos y espera el fan-in.
- Argos delega una sola vez a Sócrates, espera y revisa su trabajo.
- Sócrates implementa, prueba, integra y despliega Prometeo.
- Argos sólo declara `GO` con evidencia independiente.
- Jarvis devuelve una respuesta terminal no vacía.
- El canary mTLS directo prueba Cauce, pero no prueba el retorno a Telegram. La
  prueba definitiva debe repetirse luego desde el chat real de Steven.

## 2. Git y alcance ya cerrado

Repositorio: `/workspace/cauce-v3`

Baseline funcional del harness, anterior al commit documental de este handoff:

```text
44f4b41064113208fd53bc45289740994f3a5653
```

Al reanudar, `main`/`origin/main` deben apuntar al commit que contiene este
archivo; comprobarlo con `git rev-parse HEAD` y `git rev-parse origin/main`.

Commits relevantes, todos ya publicados:

```text
44f4b41 chore(ops): refresh container operation digests
5f46924 fix(harness): renew durable agent delivery claims
774a0bd fix(store): defer nested responses until continuation
480a611 fix(adapter): resume delegated reviews before fan-in
```

El único cambio local fuera de Git es propiedad del usuario y se preservó:

```text
?? ops/container-runtime/salva-container-keepalive.sh
```

No editar, agregar al commit, borrar, mover, copiar al bundle ni limpiar ese
archivo.

## 3. Qué corrige `5f46924`

El cambio separa la duración de ownership de una delivery de la duración de una
ejecución agentic:

- Un ACK durable `started`, correctamente cercado, renueva
  `ack_deadline_at` y `claim_expires_at`.
- El replay exacto del mismo `started` vuelve a renovar sólo si claim y lease
  continúan siendo exactamente los mismos y siguen vivos.
- Cada ACK devuelve un receipt explícito:
  `applied`, `duplicate`, `superseded` u `ownership_lost`.
- Colisiones de `event_id`, owner/epoch/token/attempt obsoletos y claims
  vencidos no renuevan nada.
- Gateway conserva la lease al cerrar una conexión que anunció
  `renewable_delivery_claims_v1`; los clientes legacy mantienen el
  comportamiento anterior.
- Tras reconexión renovable, PostgreSQL sigue siendo la autoridad. Un cliente
  legacy no puede recuperar un claim desconocido.
- Los ACK terminales tardíos en la misma conexión se admiten mediante
  `recentClaims`, limitado FIFO a 1024 entradas; no cruza reconexiones.
- El cliente persiste localmente cada renovación antes de enviarla. Un fallo de
  `fsync`, un receipt rechazado o la falta de confirmación antes del deadline
  abortan el harness exacto.
- Todos los harnesses agentic incluidos usan 24 horas por defecto
  (`86400000` ms), con overrides válidos entre 1 minuto y 7 días.
- Manifests de Claude, Codex, Hermes, OpenClaw, OpenCode y fake anuncian
  `renewable_delivery_claims_v1`.

Archivos principales:

- `packages/store/src/repository.ts`
- `services/gateway/src/app.ts`
- `packages/adapter-sdk/src/sdk/client.ts`
- `packages/adapter-sdk/src/sdk/engine.ts`
- `packages/adapter-sdk/src/bin/config.ts`
- `ops/scripts/alias-runner.sh`
- `ops/scripts/container-adapter-supervisor.sh`

## 4. Evidencia de pruebas ya obtenida

Pruebas limpias y secuenciales después del último cambio:

```text
Adapter SDK                         191/191
Store hardening                      85/85
Gateway hardening                    26/26
Integración vertical                 20/20
E2E                                   3/3
Protocol receipts                     5/5
Lint                                  PASS
Typecheck core + adapter              PASS
Build                                 PASS
Ops alias-runner                      PASS
Ops container-supervisor              PASS local non-root
Ops container-supervisor release host FAIL root context
Release gate global                   FAIL
git diff --check                      PASS
```

Revisión adversarial independiente: `GO`. Confirmó que `recentClaims` no
atraviesa reconexiones, valida instance/epoch, elimina el intento anterior ante
uno nuevo, mantiene al store como autoridad y queda acotado a 1024.

Recomendación no bloqueante de esa revisión: agregar regresiones focales para
eviction `1025→1024`, ACK tardío después de reconnect y ACK tardío después de
un attempt nuevo.

La revisión adversarial final de este handoff quedó en `GO`: confirmó rollback
coherente, candidato fallido cercado para análisis forense, doble gate de core
y override Telegram, bloqueo duro antes de adapters/POST e inventarios sin
valores secretos.

Además, sobre el host de release pasó `test-compose-authentic` con la nueva
imagen:

- cinco servicios finales en la misma imagen;
- mTLS real y aislamiento de health;
- owner duplicado cercado;
- kill real de gateway conservando entrega Telegram y una sola respuesta;
- kill real de PostgreSQL conservando el efecto webhook;
- shadow hacia target Unix real sin side effect.

El primer intento de `test-compose-authentic` falló antes del runner porque el
candidato exacto no tenía `node_modules` host y no podía importar `ws`. Se
ejecutó `corepack pnpm install --frozen-lockfile` dentro del candidato y la
repetición completa pasó. No fue un fallo del runtime ni produjo cambios Git.

## 5. Candidato de release construido

Host core: `agora-storage` (`root`)

```text
Candidato:
/opt/cauce-v3-candidates/44f4b41064113208fd53bc45289740994f3a5653

sourceDigest:
sha256:5a6cd37595f124b3cf9d4049e3ed55e28c21f855da083ae23dbb3ba97ec1b898

operationsDigest system:
sha256:fb604ada1905a06524dc73dfbdb04e0e45fcf127befa273d9b3359c5f46d3bbb

operationsDigest rootless:
sha256:8b51bd96f1bc43be543e10bfa0f333328a0a17045812f03b06f97dc0becd831b
```

Imágenes nuevas, ya publicadas en el registry local:

```text
runtime:
127.0.0.1:5000/cauce-v3-runtime@sha256:146f01ef5bf69f1f0a4de641feb7e561827451b404afb4bff18dc71c9b9c1d27

console:
127.0.0.1:5000/cauce-v3-console@sha256:4d72512794852c8eca81941e008e6a55d204a6e7c85582e783be0298dce446c5
```

Este candidato queda **sólo para análisis forense**. No desplegar sus imágenes,
no publicar un bundle nombrado con `44f4b41` y no reutilizar su SHA después de
reparar el gate. El arreglo obligatorio producirá un commit, candidato,
sourceDigest e imágenes nuevos.

El candidato y sus artefactos se conservaron. Tras fallar el release gate, el
árbol live fue restaurado; también quedó una copia recuperable del árbol
promovido fallido:

```text
/opt/cauce-v3-failed-gate-44f4b41064113208fd53bc45289740994f3a5653
```

## 6. Estado live exacto al cortar

### 6.1 Rollback preventivo ya aplicado

El release gate terminó en `FAIL`. Como todavía no se había recreado ningún
container, se restauraron inmediatamente el árbol live, `prod.env` y el
override de Telegram. El estado deseado volvió a coincidir con el estado
efectivo anterior.

`/opt/cauce-v3` volvió al source digest:

```text
sha256:04361ebea5a77094104619137edfbcc00cb46f6acfccc42e22f49a46f4664aa5
```

`/etc/cauce-v3/prod.env` volvió a los digests runtime/console anteriores y
`telegram-bridge.active.yaml` volvió al digest Telegram anterior.

Al intentar nuevamente el rollout será obligatorio actualizar también ese
override: Telegram tiene un pin separado y actualizar sólo
`CAUCE_RUNTIME_IMAGE` lo dejaría viejo.

Modos comprobados:

```text
/etc/cauce-v3/prod.env                                      0600
/etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml 0644
```

### 6.2 Containers efectivos y configuración restaurada

```text
gateway / dispatcher / outbox:
sha256:fb10dc81d52d972a6da3cc0837e56a84967b8bc63dc705da70f692e5f7693c29

console:
sha256:d7226203a4c23cb40bdaadc9796c085130e9b4361f76e6fd0d927da0af522345

telegram-bridge:
sha256:0cb603fc2c3fb13b8cf598e8df9ae50b2c1b72b5bc2f9f577ec215655319462d
```

Todos quedaron `running`, `healthy`, `RestartCount=0`. No se ejecutó ningún
`compose up`, restart ni migración con el release nuevo.

### 6.3 Respaldos ya creados

```text
/opt/_archive/cauce-v3-releases/2026-07-24/pre-44f4b41064113208fd53bc45289740994f3a5653
/etc/cauce-v3/prod.env.pre-44f4b41064113208fd53bc45289740994f3a5653
/etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml.pre-44f4b41064113208fd53bc45289740994f3a5653
```

No sobrescribir esos respaldos.

También se preservó el árbol nuevo que había sido promovido antes del rollback:

```text
/opt/cauce-v3-failed-gate-44f4b41064113208fd53bc45289740994f3a5653
```

### 6.4 Release gate fallido

La invocación histórica que produjo el fallo fue:

```bash
# HISTÓRICO: produjo FAIL; no volver a ejecutar desde el árbol live.
ssh agora-storage \
  'make -C /opt/cauce-v3/ops release-gate ENV_PROD=/etc/cauce-v3/prod.env'
```

No usar sólo `CAUCE_ENV_FILE=... make ...`: la receta de Make lo reemplaza con
`ENV_PROD`.

El gate sí progresó por manifests, operations digest, timeout 24 h, mTLS-only,
layouts, pins por alias y perfiles Hermes. Terminó después con:

```text
AssertionError:
reserved early adapter exit must remap to the restartable code:
runtime uid/gid must be a non-root identity

actual:   78
expected: 70

ops/tests/container-supervisor.test.mjs:873
```

No quedó ningún rollout parcial en containers. El fallo es reproducible en la
suite host-side y debe repararse antes de volver a promover.

Diagnóstico inicial concreto:

```text
container-supervisor.test.mjs calcula:
runtimeUid = process.getuid()
runtimeGid = process.getgid()

El release host ejecuta el gate como root, por lo que ambos son 0.
El helper endurecido rechaza correctamente UID/GID 0 en:
ops/container-runtime/cauce-container-runtime.py:1211
```

La suite local ejecutada como usuario no-root había pasado. Esto apunta a una
incompatibilidad root/no-root del fixture o del modo de ejecución del test, no a
un fallo de las imágenes authentic. No relajar el rechazo productivo de UID 0
para hacer pasar el test. La corrección debe mantener al adapter real siempre
non-root.

## 7. Procedimiento pendiente — core

### 7.1 Reparar y volver a cerrar el release gate

1. Reproducir el caso focal en un host/root equivalente.
2. Corregir el fixture o ejecutar esa suite bajo una identidad de prueba
   non-root de forma portable.
3. No cambiar `child_credentials()` para aceptar UID/GID 0.
4. Ejecutar la suite completa como usuario normal y bajo el contexto root del
   release host.
5. Commit/push del arreglo y nuevo candidato exacto `<FIXED_SHA40>`.
6. Repetir build y `test-compose-authentic` si cambia cualquier entrada de
   release.
7. Crear fuera de Git y fuera del candidato un directorio efímero:

   ```text
   /run/cauce-v3-release-gate/<FIXED_SHA40>/
   ```

   Debe ser `0700`. Crear allí:

   - `prod.env`, modo `0600`, basado en el env productivo pero con los nuevos
     RepoDigests;
   - `telegram-bridge.active.yaml`, modo `0600`, basado en el override
     productivo pero con `<FIXED_RUNTIME_REPODIGEST>`.

   No modificar todavía `/etc/cauce-v3/prod.env` ni el override live. No
   guardar estos archivos dentro del candidato porque podrían terminar
   archivados o promovidos con el código.
8. Ejecutar el gate desde el candidato exacto, no desde el árbol live:

   ```bash
   ssh agora-storage \
     'make -C /opt/cauce-v3-candidates/<FIXED_SHA40>/ops \
       release-gate \
       ENV_PROD=/run/cauce-v3-release-gate/<FIXED_SHA40>/prod.env'
   ```

9. El release gate actual no incorpora el override Telegram. Ejecutar además
   el preflight exacto de los tres composes candidatos:

   ```bash
   ssh agora-storage \
     'docker compose \
       --env-file /run/cauce-v3-release-gate/<FIXED_SHA40>/prod.env \
       -f /opt/cauce-v3-candidates/<FIXED_SHA40>/deploy/compose.yaml \
       -f /opt/cauce-v3-candidates/<FIXED_SHA40>/deploy/compose.postgres.yaml \
       -f /run/cauce-v3-release-gate/<FIXED_SHA40>/telegram-bridge.active.yaml \
       --profile telegram \
       config --images'
   ```

   Renderizar también `config --format json` y exigir que
   `services["telegram-bridge"].image` sea exactamente
   `<FIXED_RUNTIME_REPODIGEST>`. Un PASS del release gate sin este chequeo no
   acredita Telegram.
10. Exigir la línea terminal
   `release gate passed`.
11. Sólo después de ambos PASS: preparar respaldos nuevos y promover el árbol.
    Instalar atómicamente el `prod.env` y override ya validados desde `/run`;
    comprobar sus modos y luego continuar con §7.2.
12. Retirar el directorio efímero de `/run` al terminar o al abortar. Nunca
    copiarlo al candidato, a un backup de código o a Git.

El candidato `44f4b41` no debe desplegarse mientras este gate siga rojo.

Hasta obtener el PASS terminal están prohibidos `compose up`, migraciones,
recreaciones de containers, cambios del symlink ops, pins de bundle y reinicios
de adapters.

### 7.2 Aplicar runtime y consola

Con el gate verde:

```bash
ssh agora-storage \
  'CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
   /opt/cauce-v3/ops/scripts/compose.sh prod up -d --no-build --wait'

ssh agora-storage \
  'CAUCE_ENV_FILE=/etc/cauce-v3/prod.env \
   /opt/cauce-v3/ops/scripts/stack-health.sh prod'
```

Verificar migrator exitoso y que gateway, dispatcher, outbox y console usen
exactamente los nuevos RepoDigests.

### 7.3 Aplicar Telegram explícitamente

El compose base no basta porque Telegram está detrás de profile y override:

```bash
ssh agora-storage \
  'docker compose \
    --env-file /etc/cauce-v3/prod.env \
    -f /opt/cauce-v3/deploy/compose.yaml \
    -f /opt/cauce-v3/deploy/compose.postgres.yaml \
    -f /etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml \
    --profile telegram \
    up -d --no-build --wait telegram-bridge'
```

Exigir `healthy`, `RestartCount=0` y `.Config.Image` exactamente igual al nuevo
runtime.

### 7.4 Rollback core

Si falla el rollout:

1. restaurar el árbol archivado a `/opt/cauce-v3`;
2. restaurar `prod.env.pre-<SHA>`;
3. restaurar `telegram-bridge.active.yaml.pre-<SHA>`;
4. ejecutar el compose productivo;
5. ejecutar además el compose explícito de Telegram;
6. repetir health.

`ops/scripts/rollback.sh runtime` no revierte Telegram; no usarlo como único
rollback.

## 8. Procedimiento pendiente — ops rootless y bundle de adapters

Host adapters: `kratos` (`stev`)

**Gate obligatorio antes de ejecutar cualquier comando de esta sección:**

- release gate del candidato reparado terminó en PASS;
- gateway, dispatcher y outbox usan el nuevo runtime exacto;
- console usa su nuevo digest exacto;
- Telegram usa explícitamente el mismo runtime nuevo;
- migraciones y `stack-health.sh prod` están verdes;
- todos los containers anteriores tienen la imagen esperada y cero reinicios
  inesperados.

Si falta una sola condición, no cambiar el symlink `ops`, no cambiar pins y no
reiniciar ninguna unit adapter. Un adapter renovable contra el core anterior
debe considerarse una combinación inválida.

Estado anterior:

```text
ops symlink:
~/.local/share/cauce-v3/ops
→ ~/.local/share/cauce-v3/releases/ops-480a611f94b0

ops rootless digest efectivo:
sha256:a7a34557b7cdd733974cf86b16dbf89b5ed153b1a37232720fa5d5567187c77a

bundle Jarvis/Argos/Sócrates:
bus-v3-20260724-continuation-480a611f94b0

bundle digest:
sha256:4dc3e62e0627d86e813511c810a59cbf97eab04e6bfec295649506a28b6308a6

timeout efectivo:
540000 ms

capability renovable:
ausente

epochs observados antes del handoff:
jarvis=28, argos=25, socrates=25
```

Las tres units estaban activas. No comenzar el ejercicio hasta que las tres
anuncien `renewable_delivery_claims_v1`.

### 8.1 Publicar ops como release inmutable

No extraer `git archive HEAD ops` directamente sobre
`~/.local/share/cauce-v3/ops`: esa ruta es un symlink.

Crear un release nuevo identificado por el commit reparado, por ejemplo:

```text
~/.local/share/cauce-v3/releases/ops-<FIXED_SHA12>
```

Secuencia segura:

1. extraer `ops/` en `.incoming-ops-<FIXED_SHA12>`;
2. verificar allí:
   `container_ops_digest.py --rootless --check`;
3. verificar `generated/container-systemd/rootless/SHA256SUMS`;
4. aplicar `chmod -R a-w`;
5. renombrar una sola vez al release final;
6. intercambiar atómicamente el symlink `ops`;
7. conservar como rollback `ops-480a611f94b0`.

No borrar releases anteriores ni el keepalive fuera de Git.

### 8.2 Construir bundle nuevo

Nombre sugerido, siempre con el commit reparado:

```text
bus-v3-20260724-renewal-<FIXED_SHA12>
```

Desde `/workspace/cauce-v3`:

```bash
pnpm build:adapter

bundle_stage=$(mktemp -d)
pnpm --filter @cauce/adapter-sdk deploy --prod --legacy \
  "$bundle_stage/packages/adapter-sdk"

(
  cd "$bundle_stage"
  find packages -type f -print0 |
    sort -z |
    xargs -0 sha256sum > SHA256SUMS
)

chmod -R a-w "$bundle_stage"
python3 ops/container-runtime/cauce-container-runtime.py \
  bundle-digest "$bundle_stage"
```

Subirlo a un nombre `.incoming-*` bajo
`~/.local/share/cauce-v3-adapter/releases`, verificar remotamente
`sha256sum -c SHA256SUMS` y `bundle-digest`, y sólo entonces renombrarlo al
release final. No crear ni mover un symlink global `current`.

### 8.3 Canary por alias

Antes de cada cambio, volver a consultar DB y exigir cero deliveries
`leased/accepted/started` para el alias.

Primero Jarvis:

```bash
ssh kratos "bash -lc '
  set -eu
  old_release=bus-v3-20260724-continuation-480a611f94b0
  old_sha=sha256:4dc3e62e0627d86e813511c810a59cbf97eab04e6bfec295649506a28b6308a6
  new_release=bus-v3-20260724-renewal-<FIXED_SHA12>
  new_sha=REPLACE_WITH_VERIFIED_BUNDLE_DIGEST

  python3 \"\$HOME/.local/share/cauce-v3/ops/scripts/pin-container-release.py\" \
    pin jarvis \
    --expected-release \"\$old_release\" \
    --expected-sha256 \"\$old_sha\" \
    --release \"\$new_release\" \
    --sha256 \"\$new_sha\"

  systemctl --user restart cauce-v3-container-jarvis.service
  \"\$HOME/.local/share/cauce-v3/ops/scripts/container-adapter-supervisor.sh\" \
    check jarvis
'"
```

Validar luego en presencia live:

- exactamente una lease viva;
- capability `renewable_delivery_claims_v1`;
- timeout efectivo `CAUCE_DEFAULT_TIMEOUT_MS=86400000`;
- conexión y epoch coherentes;
- unit activa y supervisor `check` verde.

Sólo después hacer Argos y Sócrates; esos dos pueden reiniciarse en paralelo
porque pins, units y state son disjuntos.

Rollback CAS por alias:

```bash
python3 "$HOME/.local/share/cauce-v3/ops/scripts/pin-container-release.py" \
  rollback ALIAS \
  --expected-release "$new_release" \
  --expected-sha256 "$new_sha" \
  --release "$old_release" \
  --sha256 "$old_sha"
```

Reiniciar únicamente la unit revertida y repetir `check`.

## 9. Contexto Prometeo que debe recibir la cadena

Repositorio privado:

```text
stevenvo780/prometeo-b2b-sales
origin/main = 79797e670091237567640cb64947dd4f5bea2c73
DEV = https://prm-dev.orpractice.co/cuentas?e=canje_fallido#_
```

Argos ve `/workspace/prometeo-b2b-sales`, que tiene cuatro cambios sin commit:

```text
app/(app)/cuentas/page.tsx
app/api/auth/instagram/callback/route.ts
src/services/instagram-api.ts
src/services/instagram-api.test.ts
```

Ese worktree no se debe guardar en stash, resetear, limpiar ni commitear.
Sócrates no ve ese repo, pero `gh` dentro de su container confirmó acceso
admin/push al repo privado y puede clonar en un directorio nuevo.

No copiar secretos, cookies, sesiones ni archivos de acceso entre Argos y
Sócrates.

## 10. Prompt exacto del ejercicio

Publicar una sola vez a Jarvis:

```text
EJERCICIO REAL DE ORQUESTACIÓN. No uses @all ni contactes a socrates directamente.

JARVIS, en esta primera entrega tu única acción es emitir exactamente una delegación durable de Cauce a `argos`; no edites Prometeo ni uses terminal. El mensaje a Argos debe contener íntegramente la tarea ARGOS siguiente. Cuando Cauce te entregue después la respuesta revisada de Argos/fan-in, no vuelvas a delegar: devuelve al usuario una síntesis terminal no vacía con GO/NO GO, commit de main, SHA desplegado DEV, gates ejecutados, evidencia Instagram y cualquier acción humana exacta aún necesaria. No declares éxito sin evidencia real.

ARGOS: preserva el worktree existente `/workspace/prometeo-b2b-sales`; está sucio y no debes hacer stash/reset/checkout/commit allí. En tu primera entrega emite exactamente una única delegación durable a `socrates`, ninguna a terceros, con toda la tarea SÓCRATES de abajo y sin intentar implementarla tú. Cuando llegue la continuación de Sócrates, no redelegues: revisa independientemente desde un clone limpio o con `git fetch`+`git show origin/main` sin tocar el worktree sucio. Verifica diff, tests/typecheck/build, que main remoto apunte al commit reportado, despliegue directo a DEV desde ese commit, migraciones/health/servicios/logs pertinentes y las evidencias de OAuth/DM. Responde a Jarvis con GO sólo si todo está demostrado; si no, NO GO con la brecha concreta. Nunca copies ni muestres credenciales, cookies, tokens, headers o archivos locales de acceso.

SÓCRATES: no delegues a ningún otro agente. Resuelve de extremo a extremo `stevenvo780/prometeo-b2b-sales`. En tu contenedor el repo puede no existir: comprueba primero; si falta, clónalo con `gh repo clone` en un directorio nuevo y escribible de tu propio workspace. Registra el SHA inicial de `origin/main`. Nunca pidas que te copien secretos ni uses rutas de otro contenedor. Diagnostica en DEV `https://prm-dev.orpractice.co/cuentas?e=canje_fallido#_` y corrige la causa real del canje OAuth de Instagram. La página Cuentas debe mostrar una acción clara `Vincular Instagram` si no hay cuenta y `Reconectar Instagram` si existe; los errores deben ser seguros y accionables, sin filtrar respuesta/token de Meta. Reproduce y verifica con el navegador persistente/autenticado o API oficial disponible; no evadas anti-bot ni abras un login automatizado nuevo si dispara 429.

Implementa pruebas; ejecuta al menos tests afectados, suite, typecheck y build. Integra intencionalmente en `main` y empuja sin force. Despliega sólo DEV directamente en la VPS desde el commit (artefacto de `git archive`, staging y rollback según `docs/OPERACION.md`; GitHub Actions no cuenta como prueba). Verifica SHA desplegado, migraciones requeridas y servicios `prometeo-dev`, poller, worker y refresh.

Después de vincular, prueba el caso real pendiente: sólo responde a un DM inbound existente y dentro de la ventana permitida; jamás envíes contacto en frío. Correlaciona webhook/poller → persistencia → decisión → envío real por Instagram. Conserva evidencia sin secretos ni texto privado innecesario: UTC, IDs técnicos permitidos, captura(s) con URI local y SHA-256 donde se vea cuenta vinculada y respuesta real entregada. Si Meta todavía exige una acción humana, no inventes: devuelve el status/código seguro y una única acción exacta para Steven. Tu respuesta a Argos debe incluir SHA base/final, archivos cambiados, comandos y resultados, SHA DEV, estado de servicios, evidencia DM/capturas o el bloqueo exacto.
```

## 11. Publicación mTLS y trazabilidad

Sólo publicar cuando Jarvis, Argos y Sócrates anuncien
`renewable_delivery_claims_v1`.

**Precondiciones completas; no ejecutar este POST si se lee la sección de forma
aislada:**

- release gate reparado y preflight del override Telegram en PASS;
- core y Telegram usan los nuevos digests exactos y están healthy;
- Jarvis, Argos y Sócrates usan el bundle del `<FIXED_SHA12>`;
- los tres anuncian `renewable_delivery_claims_v1`;
- no existen deliveries previas `leased`, `accepted` o `started` para esos
  aliases.

Desde `claw`, mTLS ya fue verificado con:

```text
CA:
/opt/cauce-v3-secrets/jarvis/ca.crt

cert:
/opt/cauce-v3-secrets/jarvis/client.crt

key:
/opt/cauce-v3-secrets/jarvis/client.key

gateway:
https://100.64.0.6:8443
```

POST:

```bash
ssh kratos docker exec -i --user 1000 claw \
  curl --fail-with-body --silent --show-error \
  --cacert /opt/cauce-v3-secrets/jarvis/ca.crt \
  --cert /opt/cauce-v3-secrets/jarvis/client.crt \
  --key /opt/cauce-v3-secrets/jarvis/client.key \
  --json @- \
  https://100.64.0.6:8443/v3/messages
```

JSON por stdin:

```json
{
  "room_id": "grp.steven",
  "recipients": [
    {
      "tenant_id": "Steven",
      "alias": "jarvis"
    }
  ],
  "body": {
    "text": "REPLACE_WITH_EXACT_PROMPT_FROM_SECTION_10",
    "timeout_ms": 86400000
  },
  "idempotency_key": "prometeo-chain-REPLACE_WITH_UNIQUE_UTC",
  "lane": "interactive",
  "priority": 100
}
```

Guardar de la respuesta `202`:

- `message_id`;
- `delivery_ids[0]`;
- `trace_id`.

No reutilizar una idempotency key anterior.

Consultas read-only por `trace_id` dentro de
`cauce-v3-prod-postgres-1`:

```sql
BEGIN READ ONLY;

SELECT
  m.created_at,
  coalesce(m.body->>'type', 'request'),
  m.actor_alias,
  d.recipient_alias,
  d.status,
  d.attempt,
  coalesce(d.last_error, '')
FROM messages m
JOIN deliveries d ON d.message_id = m.id
WHERE m.trace_id = '<TRACE>'
ORDER BY m.created_at, d.created_at;

SELECT
  created_at,
  source_alias,
  target_alias,
  status,
  coalesce(rejection_code, ''),
  hop_count,
  hop_budget,
  produced_delivery_id
FROM agent_output_materializations
WHERE trace_id = '<TRACE>'
ORDER BY created_at;

SELECT
  created_at,
  coalesce(actor_alias, ''),
  action,
  decision,
  coalesce(metadata->>'child_delivery_id', ''),
  coalesce(metadata->>'source_delivery_id', ''),
  coalesce(metadata->>'target_alias', '')
FROM audit_events
WHERE trace_id = '<TRACE>'
  AND action IN (
    'message.publish',
    'agent_output.materialize',
    'agent_output.response',
    'agent_output.fanin'
  )
ORDER BY created_at, id;

COMMIT;
```

Gate esperado:

- materialización `jarvis→argos`, hop 1;
- materialización `argos→socrates`, hop 2;
- respuesta `socrates→argos`;
- revisión/respuesta `argos→jarvis`;
- fan-in terminal de Jarvis;
- cero rejected, failed, dead o timeout;
- respuesta final textual no vacía.

Para demostrar la renovación, una ejecución real superior a 60 segundos debe
mostrar más de un ACK `started` aplicado y el deadline renovado.

## 12. Prueba Telegram definitiva

El POST mTLS anterior no lleva `origin=telegram`; su resultado no aparecerá en
el chat de Steven. Tras aprobar el canary directo:

1. Steven envía desde Telegram el mismo pedido a Jarvis.
2. Se captura el nuevo `trace_id`.
3. Se verifica la misma cadena completa.
4. Se exige que el resultado de Jarvis vuelva al mismo chat, sin el mensaje
   genérico “La solicitud finalizó sin contenido textual”.

No afirmar que Telegram quedó probado sólo con el POST directo.

## 13. Inventario privado de credenciales

Se crearon dos inventarios locales, ambos modo `0600` y comprobados como
ignorados por Git:

```text
/workspace/cauce-v3/ops/private/CREDENTIAL-INVENTORY.local
/workspace/prometeo-b2b-sales/docs/ACCESOS.local.md
```

Contienen propósito, ubicación autoritativa, owner/modo observado, consumidor,
dependencias de rotación y comandos de verificación por metadata. No contienen
valores secretos.

El inventario Cauce cubre SSH de hosts, PostgreSQL, PKI gateway/consola,
identidades mTLS, Telegram por alias, relay, PKI rootless de
Jarvis/Argos/Sócrates y sesiones de herramientas que no deben transferirse.

El inventario Prometeo cubre SSH/VPS, envs prod/DEV/refresh, Meta/Instagram,
cifrado de tokens, Telegram, Anthropic/Claude, VNC/browser y GitHub. Marca como
pendiente recuperar del vault el target/key SSH, password VNC y cualquier
valor que no existe en el workspace. La password root que viajó por chat debe
rotarse.

Nunca reemplazar estos índices por copias de `.env`, private keys, tokens,
cookies o perfiles de sesión.

## 14. Checklist de reanudación

- [ ] Reparar la incompatibilidad root/no-root del test de supervisor.
- [ ] Repetir el release gate completo y obtener PASS terminal.
- [ ] Desplegar core con los nuevos digests.
- [ ] Desplegar Telegram explícitamente con su override.
- [ ] Verificar health, restart count, migraciones e imágenes efectivas.
- [ ] Publicar ops rootless como release inmutable y cambiar su symlink.
- [ ] Construir, verificar y publicar bundle adapter inmutable.
- [ ] Canary Jarvis.
- [ ] Canary Argos y Sócrates.
- [ ] Verificar capabilities, lease única y timeout 24 h en los tres.
- [ ] Publicar una sola orden mTLS a Jarvis.
- [ ] Trazar Jarvis→Argos→Sócrates→Argos→Jarvis.
- [ ] Esperar resultado real de Prometeo o bloqueo humano exacto.
- [ ] Repetir el pedido desde Telegram y comprobar el retorno al chat.
- [ ] Documentar SHA, digests, trace, evidencia y cualquier rollback aplicado.
