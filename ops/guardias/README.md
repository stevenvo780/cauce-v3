# Guardias de la flota

Procesos auxiliares que vigilan y reponen lo que el propio Cauce no repone, más las unidades systemd
que los disparan y los envoltorios que los alcanzan. Todos viven acá y se instalan **desde acá**: un
guardia que sólo exista en el disco de una máquina no se puede revisar, no se puede revertir y no
sobrevive a la pérdida de ese disco.

Ninguno contiene secretos: leen credenciales pero sólo publican una **huella** —los primeros 10 hex
de `sha256(refreshToken)`— que identifica una cuenta sin permitir reconstruirla.

## Qué vigila cada guardia, y sobre qué clase de objeto opera

| Guardia | Objeto que toca | Qué hace | Disparo |
|---|---|---|---|
| `cauce-ai-live` | cuenta de suscripción | Cuota REAL por cuenta vía CDP, no estimada | timer 10 min |
| `cauce-alertas-al-bus.py` | alertas de Prometheus | Publica en el bus UNA entrega con las alertas `firing`: sin Alertmanager nadie las lee | timer 5 min |
| `cauce-attach` | sesión viva del alias | Entra a LA sesión real del agente (`claude --resume` / `codex resume`) con guardas | manual |
| `cauce-attach-guard` | unidad del adaptador | Repone los adaptadores que quedaron parados por un attach mal cerrado | timer 2 min |
| `cauce-codex-sync` | `auth.json` de codex | Propaga la credencial compartida a los homes que no la montan; idempotente | path unit |
| `cauce-contexto-colisiones.py` | ficheros de gobierno | ¿Dos alias comparten los ficheros que los gobiernan? Compara por inodo (§ abajo) | manual |
| `cauce-credenciales` | credenciales OAuth | Audita y renueva; detecta el mismo fichero compartido entre contenedores | manual |
| `cauce-destrabar-telegram` | cursor de Telegram | Salta el update que dejó sordo a un alias (adjunto no descargable) | manual |
| `cauce-directo` | sesión del alias | Abre un alias con UN salto de pty en vez de la cadena completa: evita ptys huérfanas | manual |
| `cauce-esfuerzo` | modelo y nivel de esfuerzo | Ve/cambia por alias, por arnés o por toda la flota; sin el espejo de `ops/` (en `~/.local/share/cauce-v3/ops` o donde apunte `CAUCE_OPS_ROOT`) avisa y no corre | manual |
| `cauce-estado` | unidad + proceso + lease | ¿Trabaja o está muerto?: systemd, CPU, attach y latido del gateway, por alias o por flota | manual |
| `cauce-modal-sweeper` | modal de la TUI | Cierra el diálogo de actualización que deja al agente vivo pero mudo | manual |
| `cauce-panel-guard` | sesión tmux compartida | Repone el panel compartido si muere solo | timer 2 min |
| `cauce-quien-consume` | contenedor → cuenta | Mapa REAL de qué contenedor gasta qué cuenta: el `auth status` puede mentir | timer 10 min |
| `cauce-sesiones` | sesiones del arnés | Lista las sesiones reales por alias | manual |
| `cauce-soltar` | ventana tmux | Devuelve la ventana a su nombre por defecto: suelta la plaza tomada | manual |
| `cauce-tmux-panel` | sesión tmux compartida | Crea la TUI compartida de un alias en contenedor; sin ella el preflight deja `tui_absent` | manual |
| `cauce-v3-medico-monitor` | fallos silenciosos | El MÉDICO: vigila, adjudica y repara sólo lo demostrablemente seguro | timer cada 15 min |
| `cauce-watch` | transcript del agente | Tail en vivo, sólo lectura y acotado por tiempo | manual |
| `credential_health.py` | vencimientos y huellas | Autoridad pura compartida: clasifica vencimientos y huellas repetidas | biblioteca |
| `cred-guard.py` + `cred-guard.sh` | credenciales de la flota | Agrega quién se quedó sin `refreshToken` y qué credenciales están compartidas entre contenedores | timer 30 min |
| sonda de credenciales por host † | credenciales locales | Mide los alias que viven en un host distinto al del agregador y le empuja sólo huellas | timer 15 min |
| `polidin-guard.sh` + `contenedor/polidin-fwd.sh` | túnel dentro de un contenedor | El guardia repone el reenvío cuando el puerto deja de escuchar; el `fwd` **es** el túnel y corre dentro del contenedor | timer 2 min |
| `cauce-envoltorio-local.sh` | CLI dentro del contenedor | Envoltorio `cauce` que salta por `ssh` al host manager | instalado en el contenedor |
| `cauce-huerfanas.sh` | ptys huérfanas | Envoltorio compatible del comando canónico `ops/cli/cauce-huerfanas` | instalado en el contenedor |
| sonda de URLs externas † | URLs vigiladas | Comprueba cada URL de su lista y avisa por el bus cuando alguna deja de dar 200 | timer diario |
| inyector de check-in por alias † | entrega periódica | Publica un check-in como el propio alias (`POST /v3/messages` con su cert mTLS); la `idempotency_key` lleva la fecha, así que repetirlo el mismo día no duplica | timer diario |
| `telegram-bridge.override.yaml` | capa de compose | Deja explícito el interruptor que apaga la redacción de la ingesta (`CAUCE_TELEGRAM_REDACT_INGRESS`) | overlay de compose, instalado en `/etc/cauce-v3/compose-overrides/` |
| `systemd/*.{service,timer,path}` | disparadores | Una unidad por guardia; el fichero versionado declara su cadencia | — |

† Varios ficheros de este directorio llevan todavía en su nombre el host, el alias, el catálogo o el
destino de una instalación concreta —los marcados con † no se nombran acá por eso, y el par del túnel
se nombra sólo para que el comando de instalación sea ejecutable—. El nombre no forma parte del
contrato: lo que importa es la clase de objeto que el guardia mide.

## Dónde corre cada clase de guardia, y por qué

- **Host manager** (el que tiene el demonio Docker de los contenedores): casi todos. Los
  contenedores de agente **no tienen cron ni systemd**, así que un proceso auxiliar que muere ahí
  dentro no lo repone nadie, y el síntoma no dice «falta un proceso» —dice `Connection refused` o
  `HTTP 000`—. El host manager sí tiene systemd de usuario con `Linger=yes`, así que el guardián vive
  ahí y alcanza al contenedor por `docker exec`.
- **Host del gateway**: los que necesitan estar del lado del gateway, como unidades de **sistema**
  (root). Van ahí cuando el `POST /v3/messages` tiene que ser local y cuando los certificados de
  cliente mTLS viven en ese host root-only, de modo que no hay que copiarlos a ningún lado.
- **Dentro del contenedor**: sólo el envoltorio del CLI y el reenviador del túnel, que por
  definición corren donde está el proceso que sostienen.

La agregación de credenciales es de dos piezas a propósito: el agregador corre en un host y suma
las mediciones que las sondas locales de los otros hosts le empujan. Cada host necesita su propia
copia de `credential_health.py` junto al ejecutable que la importa.

## Tres de estos guardias los instala el CLI, no el bloque de restauración

`cauce-estado`, `cauce-sesiones` y `cauce-attach` no son herramientas sueltas: `cauce` las
**ejecuta** (`cauce <alias> estado|sesiones`, y el attach exclusivo de `cauce <alias>`). Instalar
`cauce` sin ellas deja esos subcomandos muriendo con «no such file», así que las publica
`ops/scripts/install-cauce-cli.sh` junto al CLI —siete ficheros, comprobando la sintaxis de cada uno
según su shebang y guardando copia del anterior—. Tienen que caer en el **mismo** directorio:
`cauce-estado` y `cauce-attach` resuelven `cauce-sesiones` **al lado del propio ejecutable**.

## El guardia de alertas lee Prometheus por `docker exec`, no por HTTP

`deploy/compose.yaml` deja `prometheus` en la red `backend` **sin `ports:`** y detrás de
`profiles: [observability]` (publicado «—», interno 9090; ver la tabla de puertos de
`../../docs/arquitectura.md`). O sea: `127.0.0.1:9090` **no responde en ningún host**, y un guardia
que lo consultara así fallaría en el 100 % de las corridas. Por eso el guardia entra a la red del
compose desde fuera: `ssh <host-del-gateway>` y
`docker exec <proyecto>-prometheus-1 wget -q -O - .../api/v1/alerts` (`wget` es el cliente que la
propia imagen usa en su healthcheck; `curl` no está). `--http-directo` existe sólo para correrlo
desde un contenedor que ya esté en `backend`, y `--desde-fichero` para las pruebas.

Requisitos de instalación, entonces: la cuenta que dispara el timer necesita **ssh sin contraseña**
al host del gateway (el guardia usa `BatchMode=yes`) y ese destino necesita acceso al `docker` de la
máquina. Son los mismos dos permisos que ya usa el médico. Ojo: ese destino **va literal en una
constante del script** (`cauce-alertas-al-bus.py:50`, usada en el `ssh` de la línea 96) — no hay
alias `Host` de por medio, ni variable de entorno, ni bandera: cambiarlo exige editar el fichero.

Y cuando la lectura falla —Prometheus apagado por el perfil, ssh caído, JSON ilegible— el guardia
**publica igual** una entrega diciendo que está ciego. Callarse ahí sería repetir, una capa más
arriba, el fallo que este guardia viene a tapar: nadie lee el journal del timer.

## El guardia de colisiones de contexto mide inodos, nunca contenido

`cauce-contexto-colisiones.py` responde una sola pregunta: **¿hay dos alias escribiendo los mismos
ficheros de gobierno?** Cuando los hay no aparece ningún error —desde un contenedor todo se ve
correcto—, y editar «el `CLAUDE.md` de un alias» reescribe el del otro. Dos alias que comparten un
solo `$HOME` pueden no chocar hoy sólo porque usan arneses distintos (§4.6 de
`../../docs/directiva-ficheros-del-agente.md`); dejan de no chocar en cuanto uno cambia de arnés.

**De dónde saca las rutas.** La flota sale del inventario `ops/flota.json` y las raíces y nombres de
documento por arnés del contrato generado `ops/schemas/contexto-de-gobierno.json` —el mismo que
proyecta la consola—, más la plantilla del espacio openclaw de `ops/scripts/fleet_derive.py`. No hay
tabla escrita a mano: una copia a mano se desincroniza y el guardia acabaría bendiciendo una
disposición que nadie sirve. Si el espejo de `ops/` no está a mano, lo dice y no corre
(`$CAUCE_OPS_ROOT`, el checkout donde vive el fichero, o `~/.local/share/cauce-v3/ops`).

**Qué mide y qué publica.** Resuelve cada ruta (`realpath`) y la agrupa por `st_dev`/`st_ino`
dentro de un mismo demonio docker (`dockerHost` del inventario): los dispositivos de overlay son por
núcleo, así que coincidir entre dos demonios distintos no es compartir y no se agrupa. No abre
ningún fichero: del contenedor sólo salen rutas, dispositivo, inodo y alias, así que un documento de
gobierno con un secreto dentro no puede escaparse por el informe.

| Regla | Severidad | Qué significa |
|---|---|---|
| `mismo_inodo` | alerta | Dos alias sobre el mismo fichero: no tienen dos contextos, tienen uno |
| `misma_raiz` | alerta si sus arneses nombran algún documento igual, aviso si no | Una sola raíz de gobierno para varios alias |
| `mismo_hogar` | aviso | Un solo `$HOME` con arneses distintos: chocarían en cuanto uno cambie de arnés |
| `ruta_ilegible`, `hogar_ausente`, `raiz_ausente`, `alias_no_proyectable` | alerta | Falla cerrado y nombra al alias: sin medir no puede afirmar que no comparte contexto |

Sale con **1 si hay alguna alerta** y 0 si sólo hay avisos. Deja el informe completo en
`~/.local/state/cauce-v3/contexto-colisiones.json` (`--estado`), el contador
`cauce_context_path_collisions{severidad=...}` en formato de exposición en
`~/.local/state/cauce-v3/contexto-colisiones.prom` (`--prometheus`) y una línea por hallazgo en la
salida estándar (`--json` para el informe entero).

**Dónde mide.** Igual que sus hermanos, corre en el host manager y entra a la casa de cada alias:
los `host:` en la propia máquina, los contenedores del demonio local por `docker exec`, y el resto
por `ssh` al otro demonio docker (`--agora <destino>`). Necesita, entonces, los mismos dos permisos
que el médico. `--raiz <dir>` sustituye la sonda entera por un árbol local `<dir>/<contenedor>/...`
y es lo que usan las pruebas: el gate corre en un árbol compartido y no puede montar nada.

**Dos cosas que NO ve, a propósito.** Un hecho de runtime que mueva una raíz
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CAUCE_OPENCLAW_WORKSPACE`) no está en el inventario: el guardia
juzga la disposición declarada, que es la que proyecta la consola, y una raíz movida a mano queda
fuera de su vista. Y compara alias contra alias, así que dos **contenedores** que montan el mismo
`.claude` para el mismo alias no le aparecen si uno de los dos no está en `ops/flota.json`.

Y el contador no lo raspa nadie: `ops/observability/prometheus.yaml` sólo raspa los `/metrics` de
los servicios, no hay colector de ficheros de texto. La señal de guardia sigue siendo el código de
salida y el informe.

## Restaurar después de una pérdida de disco

El agregador de credenciales corre como unidad de **SISTEMA**, no de usuario: `Type=oneshot` como
root, disparado por su timer. El script se instala con **otro nombre** que el fichero de este repo,
y `credential_health.py` va en el mismo directorio para que el import relativo resuelva. Las
plantillas versionadas en `systemd/cred-guard.*` están escritas para una unit `--user`: restaurar la
unit real es el rename de abajo, no una copia literal de esas plantillas.

```sh
# En el host del agregador, con el repo clonado — unit de SISTEMA (root), no de usuario
install -d -m755 /usr/local/sbin
install -o root -g root -m750 ops/guardias/credential_health.py /usr/local/sbin/
install -o root -g root -m750 ops/guardias/cred-guard.py /usr/local/sbin/cauce-cred-guard.py
install -o root -g root -m644 ops/guardias/systemd/cred-guard.service /etc/systemd/system/cauce-cred-guard.service
install -o root -g root -m644 ops/guardias/systemd/cred-guard.timer /etc/systemd/system/cauce-cred-guard.timer
sed -i 's#^ExecStart=.*#ExecStart=/usr/local/sbin/cauce-cred-guard.py#' /etc/systemd/system/cauce-cred-guard.service
systemctl daemon-reload
systemctl enable --now cauce-cred-guard.timer

# En el host manager, con el repo clonado — units de usuario
install -d -m755 ~/.local/bin ~/.config/systemd/user
install -m644 ops/guardias/credential_health.py ~/.local/bin/     # biblioteca, no ejecutable
install -m755 ops/guardias/<guardia>... ~/.local/bin/             # los guardias que ese host corre
./ops/scripts/install-cauce-cli.sh   # cauce + panel/huerfanas/reponer + estado/sesiones/attach
install -m644 ops/guardias/systemd/<unidad>.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now <timer>...
```

Los envoltorios `cauce-envoltorio-local.sh` y `cauce-huerfanas.sh` NO van acá: van dentro del
contenedor, que es donde se los invoca.

Dentro del contenedor que sostiene un túnel:
`install -m755 ops/guardias/contenedor/polidin-fwd.sh <destino en el contenedor>`.

**Comprobá el efecto, no el `systemctl start`.** Matá el proceso a propósito y verificá que el
guardián lo repone. Para un túnel, el banner por TCP crudo prueba la cadena entera sin autenticar
—y sin gastar un intento contra el `fail2ban` del destino, que puede banear al host entero a los
pocos fallos—:

```sh
exec 3<>/dev/tcp/<ip-del-contenedor>/<puerto>; read -t 8 linea <&3; echo "$linea"   # -> SSH-2.0-OpenSSH_...
```

Para el inyector de check-in el efecto es **una fila nueva en `deliveries`**, y hay que buscarla por
`recipient_tenant`/`recipient_alias`: esa tabla no tiene `tenant_id` ni `alias`
(`packages/store/migrations/001_initial.sql:77-78`), así que la consulta obvia muere con «column
does not exist» y el fallo se confunde con «el inyector no publicó nada».

## Lo que este directorio NO cubre

- El parche compilado que **montaba** el override de Telegram. Ya no lo monta nadie: el override
  pasa a expresar la decisión con `CAUCE_TELEGRAM_REDACT_INGRESS`, y el fuente que se compilaba
  desapareció al mudarse la redacción a `@cauce/protocol` (`packages/protocol/src/redaction.ts`). Si
  ese `.js` sigue en el disco de algún host, es basura: no lo lee nadie y se puede borrar.
- Las credenciales. A propósito: se rehacen con un login por agente, nunca copiando el archivo de
  otro —copiarlo es exactamente lo que deja a un alias sin `refreshToken`, porque el refresh token
  de OAuth es de un solo uso y el primero que refresca deja gastado el de los demás.
