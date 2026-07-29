# Runbook: recolector de cuotas de IA

## Por que existe

El consumo de las suscripciones de IA (`claude`, `codex`, `antigravity`, `opencode`) lo sabe
el CLI local `ai-usage` (el mismo dato que expone la tool MCP `get_ai_quotas`), que corre en
kratos y dentro de los contenedores de agente. El gateway y la consola corren en agora-storage y
no tienen forma de leer eso: **este recolector es el puente**. Sin el, el panel de cuotas de la
consola no tiene de donde leer y el incidente que lo motivo -- una suscripcion paga agotada sin
que nadie lo viera hasta que fue tarde -- se repite en silencio.

El recolector NO calcula nada de flota (eso sale de SQL en `GET /v3/console/activity`, todo
derivable de la base). Solo hace tres cosas: muestrea `ai-usage`, normaliza su salida a
`(host, provider, group_key, window_key)`, y publica por mTLS contra
`POST /v3/quotas/samples`. Ver `packages/store/migrations/013_quota_observation.sql` para el
porque de ese modelo (cuatro tablas, no una) y la forma completa del contrato.

## Que publica y por que asi

- **Nunca aplasta a un numero por proveedor.** `codex` puede tener dos grupos con `limitId`
  distinto (`codex` agotado, `codex_bengalfox` libre); se publican como grupos separados. La
  normalizacion es `group_key = window.limitId (o el campo equivalente) o 'default'`,
  `window_key = window.key`.
- **`account_id` lo decide el recolector, no el gateway.** Un archivo de intencion local
  (`CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE`, ver `ops/config/quota-collector-account-bindings.json.example`)
  mapea `(provider, group_key)` a un `account_id` de `provider_accounts`. Si un grupo no tiene
  entrada ahi, se publica igual con `account_id=null` y una `binding_note`: el gateway lo va a
  mostrar como "sin atar" en vez de perder el dato (`unbound_groups[]` en `GET /v3/console/quotas`).
- **Si un proveedor no responde, se publican los que si.** Cada entrada de proveedor lleva su
  propio `ok`/`available`; un proveedor roto no descarta el resto. Si el CLI `ai-usage` entero
  no corre (binario ausente, timeout, JSON invalido), se publica un reporte `ok=false` por cada
  proveedor de `CAUCE_QUOTA_PROVIDERS` **en vez de no publicar nada** -- publicar la falla es
  la unica forma de que `collectors[].stale` en el panel distinga "no hay dato" de "el
  recolector dejo de correr".
- **Nunca se loguea contenido de credenciales.** El script solo pasa PATHs de certificados a la
  libreria `ssl`; nunca los lee ni los imprime. Los mensajes de error de `ai-usage` se acotan a
  300 caracteres de `stderr` (nunca `stdout` completo, por si algun proveedor llegara a volcar
  un token ahi).

## Instalacion en kratos (usuario `stev`)

### 1. Codigo

Mismo arbol que ya usan los adapters (`ops/runbooks/container-adapters.md`):

```sh
install -d -m 0755 ~/.local/share/cauce-v3/ops/scripts
install -m 0755 ops/scripts/quota-collector.py ~/.local/share/cauce-v3/ops/scripts/quota-collector.py
```

### 2. Identidad mTLS dedicada

El recolector es un demonio, no un navegador ni un alias de trabajo: usa su propia identidad
`Steven:quota-collector`, con rol `operator` y **solo** el permiso `control` (no necesita
`read`: no lee el panel, solo publica). Generar/firmar `client.crt`/`client.key` con la CA de
Cauce igual que para cualquier otro alias (no hay una herramienta de emision en este repo; usar
el procedimiento que ya gestiona quien administra la CA) y publicarlos junto con `ca.crt`:

```sh
install -d -m 0700 ~/.config/cauce-v3/container-pki/quota-collector
# copiar ahi client.crt, client.key (0600) y ca.crt, igual que container-adapters.md paso 3
```

Agregar la identidad al registro de mTLS (`mtls_identities.json`, ver
`ops/runbooks/authentication.md`), calculando el fingerprint SHA-256 del `client.crt` recien
emitido:

```json
{
  "certificate_sha256": "<64-hex del client.crt de quota-collector>",
  "expires_at": "<vencimiento del cert>",
  "principal": {
    "tenant_id": "Steven",
    "alias": "quota-collector",
    "session_id": "quota-collector",
    "channel": "adapter",
    "roles": ["operator"],
    "permissions": ["control"]
  }
}
```

Publicar el registro por el **directorio montado** (`CAUCE_GATEWAY_IDENTITY_DIR`), nunca como
archivo suelto -- ver "Montaje de los registros" en `authentication.md`; un bind de archivo
suelto hace que ni el alta ni una revocacion futura lleguen al gateway.

### 3. Archivo de intencion (account bindings)

```sh
install -d -m 0700 ~/.config/cauce-v3/quota-collector
install -m 0600 ops/config/quota-collector-account-bindings.json.example \
  ~/.config/cauce-v3/quota-collector/account-bindings.json
# completar con los account_id reales de provider_accounts (ver AccountsPage de la consola)
```

Un grupo sin entrada aca **no se pierde**: se publica con `account_id=null` y aparece en
`unbound_groups[]` del panel. No hace falta tener el mapeo completo antes de prender el
recolector.

### 4. Config no secreta

```sh
install -m 0600 ops/config/quota-collector.env.example ~/.config/cauce-v3/quota-collector.env
# editar CAUCE_QUOTA_HOST, CAUCE_QUOTA_PKI_DIR y CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE si difieren
```

### 5. Units de usuario

Mismo patron que `container-adapters.md` (`WantedBy=default.target`, sin `User=`, sin
sandboxing que pida privilegios del manager de sistema):

```sh
install -d -m 0700 ~/.config/systemd/user
install -m 0644 ops/systemd/cauce-v3-quota-collector.service ~/.config/systemd/user/
install -m 0644 ops/systemd/cauce-v3-quota-collector.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cauce-v3-quota-collector.timer
```

`loginctl enable-linger stev` debe estar activo (ya deberia estarlo: es requisito de los
adapters existentes) para que el timer sobreviva al logout.

### 6. Verificacion

```sh
systemctl --user status cauce-v3-quota-collector.timer
systemctl --user start cauce-v3-quota-collector.service   # corrida manual, no espera al timer
journalctl --user -u cauce-v3-quota-collector.service -n 30 --no-pager
```

El log de una corrida sana termina con una linea `POST ... -> 202` y un resumen
(`collection_id=... duplicate=False accepted_providers=N accepted_windows=M`). Nunca debe
aparecer contenido de certificado ahi -- si aparece, es un bug de este script, no un detalle a
ignorar.

Para probar el mapeo sin publicar nada:

```sh
CAUCE_QUOTA_DRY_RUN=1 ~/.local/share/cauce-v3/ops/scripts/quota-collector.py
# o, contra una captura ya guardada de ai-usage:
python3 ~/.local/share/cauce-v3/ops/scripts/quota-collector.py --dry-run --input-file /tmp/captura.json
```

## Cadencia: cada 5 minutos

No es un numero arbitrario: es la misma cadencia que asume el comentario de costo de
`packages/store/migrations/013_quota_observation.sql` (~15 ventanas/corrida x 288 corridas/dia
= ~4.3k filas/dia, ~130k en 30 dias de retencion). Correr mas seguido no agrega informacion
util -- las ventanas de sesion no cambian tan rapido y cada corrida hace un roundtrip a 4 CLIs
externos -- y correr mas espaciado empieza a comerse el margen contra
`thresholds.stale_after_seconds = 900` (15 min) que usa `GET /v3/console/quotas`: con 5 minutos,
hacen falta 3 corridas seguidas fallidas antes de que el panel marque el collector como
`stale`, que es el margen que se quiere para absorber un timeout aislado de un CLI sin generar
una alarma falsa.

## Seguridad

- **mTLS con verificacion de hostname siempre prendida.** El recolector conecta por la IP de la
  tailnet (`100.64.0.6`) y verifica el certificado del gateway contra esa misma IP
  (`check_hostname=True`; Python valida IP-literales contra SANs de tipo IP igual que contra
  nombres DNS). Es el mismo patron que ya usa `ops/pty-agent/cauce_pty_agent.py`
  (`_tls_context`/`_connect`). Si algun dia el certificado del gateway no trae esa IP como SAN,
  el escape hatch es `CAUCE_QUOTA_GATEWAY_SERVER_NAME` (mismo rol que `RELAY_SERVER_NAME` en
  `ops/pty-agent`) -- **no** se apaga la verificacion.
- **`ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT`**: la CA interna de Cauce no trae la extension
  de Key Usage; sin este parche, un Python con `VERIFY_X509_STRICT` disponible rechaza un
  certificado de cadena por lo demas valida. No afecta la verificacion de cadena ni de
  hostname, solo un chequeo extra de perfil de certificado.
- **La ruta vive fuera de `/v3/console/`.** `createConsoleSecurityHook` responde 403 a todo
  metodo inseguro bajo ese prefijo sin un header `Origin` same-origin, y un demonio con
  certificado de cliente jamas manda `Origin`. `POST /v3/quotas/samples` esta al lado de
  `/v3/messages` y `/v3/egress/notifications` por el mismo motivo.
- **La identidad `quota-collector` solo tiene el permiso `control`.** No puede leer
  `/v3/console/activity` ni `/v3/console/quotas`; solo publicar. Un agente de trabajo comun
  (rol `agent`) nunca deberia tener el permiso `control` sobre esta ruta -- verificarlo con un
  intento de `POST` con la identidad de un alias cualquiera y confirmar 403.
- **Vector de riesgo conocido, ya mitigado en el contrato del endpoint (no en este script):**
  una muestra que declare `remaining_percent<=0` sobre una cuenta atada dispara la auto-pausa de
  la 013. Por eso la identidad del recolector es dedicada y de solo-`control`, y por eso la
  auto-pausa se acota siempre a `reset_at` (nunca indefinida). Este script no decide pausar
  nada: solo informa lo que `ai-usage` reporto.

## Variables de entorno

Ver `ops/config/quota-collector.env.example` para la lista completa con comentarios. Las que
mas importan operar:

| Variable | Default | Para que |
|---|---|---|
| `CAUCE_QUOTA_GATEWAY_URL` | `https://100.64.0.6:8443/v3/quotas/samples` | destino del POST |
| `CAUCE_QUOTA_GATEWAY_SERVER_NAME` | (vacio = usa el host de la URL) | override de verificacion de hostname si el cert no trae SAN de IP |
| `CAUCE_QUOTA_PKI_DIR` | `~/.config/cauce-v3/container-pki/quota-collector` | `client.crt`/`client.key`/`ca.crt` |
| `CAUCE_QUOTA_HOST` | `hostname()` de la maquina | columna `host` de `quota_collections` (explicito, no derivado, para no confundir dos hosts con la misma suscripcion) |
| `CAUCE_QUOTA_AI_USAGE_CMD` | `ai-usage --json` | como invocar el CLI |
| `CAUCE_QUOTA_PROVIDERS` | `claude,codex,antigravity,opencode` | fallback cuando el CLI entero no responde |
| `CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE` | `~/.config/cauce-v3/quota-collector/account-bindings.json` | archivo de intencion `(provider,group_key)->account_id` |
| `CAUCE_QUOTA_HTTP_RETRIES` | `2` | reintentos ante fallo de RED (nunca ante 4xx: ahi reintentar no ayuda) |
| `CAUCE_QUOTA_INPUT_FILE` / `--input-file` | (vacio) | solo debug: lee JSON de un archivo en vez de invocar `ai-usage` |
| `CAUCE_QUOTA_DRY_RUN=1` / `--dry-run` | `0` | arma el payload y lo imprime; no publica |

## Codigos de salida (para leer `journalctl` o alertar sobre el `.service`)

- `0`: publicado con exito. Incluye el caso "se publico un reporte de falla total": el POST en
  si funciono, lo que fallo fue la fuente de datos, y eso ya es informacion util.
- `1`: fallo de red/HTTP contra el gateway tras agotar reintentos. Vale la pena alertar si se
  repite en corridas consecutivas (el timer va a reintentar solo en 5 minutos).
- `2`: error de configuracion local (host invalido, PKI ausente o corrupta, `--input-file`
  ilegible). Nada se intento publicar. No se arregla solo: requiere revisar el `.env` o el
  directorio de PKI.

## Troubleshooting

- **`falta client.crt en <dir>` (exit 2):** el directorio de `CAUCE_QUOTA_PKI_DIR` no tiene los
  tres archivos esperados, o el path configurado no es el que se penso. Nunca vuelca contenido:
  solo dice que archivo falta.
- **`PKI invalida en <dir>: [X509] PEM lib` (exit 2):** alguno de los tres archivos no es un PEM
  valido (typo al copiar, archivo truncado). Regenerar/recopiar.
- **`CERTIFICATE_VERIFY_FAILED: IP address mismatch` (exit 1, tras 3 intentos):** el certificado
  del gateway no trae `100.64.0.6` (o el host que se este usando) como SAN. Confirmar con
  `openssl x509 -in <cert> -noout -text | grep -A1 'Subject Alternative Name'`; si en efecto no
  la trae, completar `CAUCE_QUOTA_GATEWAY_SERVER_NAME` con el nombre que si figura en el SAN.
- **`ai-usage no respondio: binario no encontrado` en el `note` de todos los proveedores:** la
  unit de systemd arranca con un `PATH` minimo y `ai-usage` no esta en el; el script ya prueba
  `~/.local/bin/ai-usage` como fallback, pero si vive en otro lado hay que fijar
  `CAUCE_QUOTA_AI_USAGE_CMD` con la ruta completa.
- **`schemaVersion reportado (N) distinto del esperado (2)` en el log:** `ai-usage` cambio de
  forma. No es fatal -- se publica igual -- pero conviene revisar si el mapeo de este script
  sigue siendo correcto para la version nueva antes de que el gateway empiece a rechazar con
  422.

## Pruebas

`ops/tests/test_quota_collector.py` corre standalone (sin PostgreSQL, sin kratos):

```sh
python3 ops/tests/test_quota_collector.py
```

Cubre: normalizacion del shape real de `ai-usage` (fixture en `ops/tests/fixtures/`,
`ops/tests/fixtures/ai-usage-sample.json`), separacion de `codex` en dos grupos por `limitId`,
resolucion de `account_id` contra el archivo de bindings, degradacion ante un proveedor
malformado / una ventana sin numeros / un CLI ausente / una salida sin `providers` (en todos los
casos: se publica lo que se puede, exit 0), `--host` invalido (exit 2), PEM corrupto (exit 2,
sin traceback), y de punta a punta contra un servidor HTTPS descartable con mTLS real: handshake
exitoso con un certificado con SAN de IP, rechazo real de un certificado que no matchea la IP de
conexion (prueba que `check_hostname` esta genuinamente activo), el override
`CAUCE_QUOTA_GATEWAY_SERVER_NAME` resolviendo ese caso, y que un fallo de red nunca vuelca
contenido de `client.key`. Los tests que necesitan generar certificados se saltean con un aviso
si `openssl` no esta instalado en la maquina que corre los tests.
