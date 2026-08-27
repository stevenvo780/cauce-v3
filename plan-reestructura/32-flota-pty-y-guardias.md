# 32 — Flota PTY y guardias del host

**Fase:** 3 (la parte URGENTE puede adelantarse, es estado, no código) · **Tamaño:** pequeño-mediano · **Ejecutor:** Claude CON el dueño · **Revisor:** Codex
**Rama:** ninguna — directo a `main` · **Depende de:** 31 para lo de código; la limpieza de huérfanos NO depende de nada

## A. URGENTE — el bucle de expulsión mutua (estado, no código)
Diagnóstico verificado: hay 24 procesos `cauce-pty-agent-<alias>.py` dentro de los contenedores para 10 clientes `docker exec` vivos (huérfanos de los rollouts del 25-ago 13:54, 26-ago 23:07/23:08 y 27-ago 00:01; argos y atlas con 4–5 cada uno). Todos los procesos de un alias comparten certificado → el relay no los distingue → cada HELLO expulsa al anterior (`agent-leg.ts: previous.destroy('superseded')`) → ~46.000 conexiones/93 min, sesiones humanas muertas en ~1 s, 92% del tráfico del gateway, log útil reducido a 2,2 h.

1. Inventariar: por contenedor, `pgrep -af cauce-pty-agent`; casar con los `docker exec` vivos del host y las 10 unidades `cauce-v3-pty@*` de systemd --user.
2. Matar SOLO los huérfanos (los sin cliente asociado), alias por alias, con el dueño confirmando. Verificar tras cada alias: el ritmo de `terminal_relay_agent_connected` cae, y una sesión de TUI abierta desde la consola sobrevive >60 s.
3. Causa raíz en `ops/pty-agent/rollout-pty.py` / `cauce-pty-launcher.sh`: al reinstalar, systemd mata el `docker exec` del host pero el Python dentro del contenedor sobrevive. Arreglo: el launcher, antes de arrancar, mata cualquier `cauce-pty-agent-<alias>.py` previo dentro del contenedor (ya tiene `flock` por alias en el host; falta el equivalente dentro del contenedor).
4. Además: solo 5 de 17 configs tienen `HARNESS_COMMAND`, los 4 contenedores OpenClaw no tienen tmux instalado, y la tmux `cauce-zeus` configurada no existe. Reconciliar los manifiestos con la realidad de cada contenedor (qué alias deben ofrecer TUI y con qué comando).

## B. Guardias del host
Verificado: los guardias que corren (`/usr/local/sbin/cauce-{cred-guard,bootstrap-guard,revividor-de-colas,openclaw-gateway-guard,cred-descompartir}`) **no están versionados en ningún repo** (y este host es RAID 0 — la razón declarada de ops/guardias/ era exactamente evitar esto). Y ninguno tiene canal de aviso: fallan en silencio (`cred-guard` está en `failed` ahora mismo con una credencial muerta detectada).

1. Copiar los scripts reales de `/usr/local/sbin/` + `/usr/local/share/cauce/bootstrap-budget-probe.mjs` a `ops/guardias/host/` y commitearlos tal cual (son la verdad; el `cred-guard.py` que hay en ops/guardias es de OTRA flota — moverlo a `ops/guardias/kratos/`).
2. Darles canal: `OnFailure=cauce-alerta@%n.service` que mande aviso por Telegram (el bridge ya existe y es el canal que el dueño SÍ mira; `cauce-v3-host-backup` ya tiene el patrón OnFailure como referencia).
3. El vigía de flota escribe informes "critical" cada 10 min y su unidad dice "NO avisa a nadie" (965 informes acumulados): conectarlo al mismo canal o apagarlo.
4. Prometheus: no scrapea el gateway y sus 6 alertas critical disparan contra un Alertmanager que no está desplegado. Decisión del dueño: desplegar `compose.alertmanager.yaml` con receptor Telegram, o quitar las alertas y quedarse con los guardias — pero UNA de las dos, no tres capas mudas.
5. Renovar la credencial Claude de socrates (ws-prizma) — hoy muerta, sin refreshToken.
6. zeus: su adaptador no corre desde el 25-ago (bundle instalado, proceso ausente, 1 entrega pending). Levantarlo y ver la entrega completarse.

## Gate de aceptación
- Ritmo de conexiones del relay < 1/min por alias en reposo (hoy: ~29.000/h en total).
- Una sesión TUI humana sobrevive >10 min (como el 24-ago).
- `systemctl --failed` limpio, y un fallo provocado de un guardia llega a Telegram en <1 min (probarlo rompiéndolo a propósito una vez).
- Los scripts de `/usr/local/sbin` idénticos a los versionados (diff vacío) y documentado cómo se instalan.
