# Censo de huérfanos v2 — procesos PTY en flota Cauce V3

Generado el 2026-08-27. Censo **READ-ONLY** (docker ps / docker exec ps / docker logs).
Ningún proceso fue tocado.

## A. Resumen ejecutivo

- **Contenedores `cauce-v3-prod-*` UP**: 9/9 (console, dispatcher, gateway, otel-collector,
  outbox-metrics, postgres, prometheus, telegram-bridge, terminal-relay).
- **Alias declarados en `ops/container-aliases.json`**: 11
  (`argos, atlas, hegel, iza, janus, jarvis, kant, kratos, salva, socrates, zeus`).
- **Alias operativos reales medidos en host local**: 13
  (los 11 de arriba + `heraclito` y `tales` de Jhon, fuera del JSON; `salva` corre
  en `ws-isa` sobre el host remoto `kratos`, fuera de este host).
- **Procesos `cauce-pty-agent-*` vivos en host local**: 22 (en 9 contenedores).
- **Procesos `cauce-container-runtime` vivos**: 10 (uno por alias excepto iza y zeus,
  que NO tienen runtime — solo pty-agent huérfano).
- **Estado del bucle**: **calmado en pareabilidad, alto en frecuencia**. El relay
  registra ~99.7k eventos `agent_connected` + `agent_disconnected` desde su arranque
  (2026-08-25T13:53Z, ~48h). Cada connect tiene su disconnect pareado (no runaway),
  pero la cadencia es ~3-4 reconexiones/minuto por alias — heartbeat/restart cíclico
  del supervisor, no tormenta. No hay errores/fatal/panic en gateway ni dispatcher.

## B. Censo por contenedor

`runtime` = `cauce-container-runtime.py` (supervisor del adapter). `pty` = `cauce-pty-agent`.
`churn 48h` = pares connect/disconnect vistos por el relay (proxy del supervisor).

| contenedor | alias esperado | runtime vivos | pty-agents vivos | duplicados | churn 48h | veredicto |
|---|---|---|---|---|---|---|
| cauce-v3-prod-console-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-dispatcher-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-gateway-1 | (infra) | 0 | 0 | 0 | 0 errors 24h | OK |
| cauce-v3-prod-otel-collector-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-outbox-metrics-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-postgres-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-prometheus-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-telegram-bridge-1 | (infra) | 0 | 0 | 0 | n/a | OK |
| cauce-v3-prod-terminal-relay-1 | (infra) | 0 | 0 | 0 | 99787 eventos | OK (logs churn visible) |
| agv2-jhon-heraclito-oc | heraclito (OP) | 1 (912942s) | 1 (197634s) | 0 | 0 (no aparece en relay) | OK — operativo |
| agv2-jhon-tales-oc | tales (OP) | 1 (665359s) | 1 (197633s) | 0 | 0 (no aparece en relay) | OK — operativo |
| agv2-jhon-hegel-oc | hegel | 1 (912974s) | 2 (197634+74779s) | **1 dup pty** | 3585 pares | kill-list (1 pty sobrante) |
| ctrl-infra | argos, kant | 1 argos (913289s) | 4 argos + 1 kant | **3 dup argos pty** | 10742 pares argos | kill-list (3 pty argos sobrantes) |
| claw | jarvis | 1 (312737s) | 2 (197633+74766s) | **1 dup pty** | 3586 pares | kill-list (1 pty sobrante) |
| claw-miguel | janus | 1 (191683s) | 2 (197634+74771s) | **1 dup pty** | 3578 pares | kill-list (1 pty sobrante) |
| ws-humanizar | atlas, iza, kratos | 2 (atlas+kratos) | 4 atlas + 2 kratos + 1 iza | **3 dup atlas pty + 1 dup kratos pty + 1 pty-iza sin runtime** | 10699 atlas + 3581 kratos + 3586 iza | kill-list (4 dup pty + 1 huérfano) |
| ws-isa | salva | — | — | — | 3474 pares (legacy) | contenedor NO existe local; `salva` corre en host remoto `kratos` — fuera de scope |
| ws-prizma | socrates | 1 (913408s) | 2 (197633+74736s) | **1 dup pty** | 3590 pares | kill-list (1 pty sobrante) |
| ws-zeus | zeus | **0** | 1 (197633s) | 0 (sin runtime) | 0 (zeus no aparece en relay) | **ANÓMALO**: pty-agent sin runtime — kill (huérfano) |

Notas:
- Hay dos "oleadas" de pty-agents claramente diferenciadas por etimes:
  **Generación A** (master, etime ~197633s ≈ 2.28 días) — los originales.
  **Generación B** (duplicados, etime ~74736-78001s ≈ 21h) — lanzados tras un
  restart hace ~21h. La Generación A nunca fue matada cuando se reinició el
  launcher; la B es la "limpia" que el supervisor actual lanzó encima.
- `dedalo` (tenant `Pablo`) aparece en el relay log (3475 pares) pero NO tiene
  contenedor ni proceso en ningún host conocido — es **stale entry en el relay**,
  no es kill candidate (no hay PID que matar).

## C. Kill-list final

13 entradas. Selección por PID, criterio "matar el duplicado/huérfano, conservar el master":

| contenedor | pid | etime | comando (truncado a 80 chars) | motivo | comando exacto para matar (NO EJECUTAR) |
|---|---|---|---|---|---|
| agv2-jhon-hegel-oc | 291862 | 74779s | `python3 /var/tmp/cauce-pty-agent-hegel.py --bundle /var/tmp/.cauce-pty-bundle-hegel.json` | dup hegel (master: 285547, 197634s) | `docker exec agv2-jhon-hegel-oc kill 291862` |
| ctrl-infra | 3736363 | 78001s | `python3 /var/tmp/cauce-pty-agent-argos.py --bundle /var/tmp/.cauce-pty-bundle-argos.json` | dup argos (master: 3406530, 197634s) | `docker exec ctrl-infra kill 3736363` |
| ctrl-infra | 3736489 | 77972s | `python3 /var/tmp/cauce-pty-agent-argos.py --bundle /var/tmp/.cauce-pty-bundle-argos.json` | dup argos | `docker exec ctrl-infra kill 3736489` |
| ctrl-infra | 3744846 | 74793s | `python3 /var/tmp/cauce-pty-agent-argos.py --bundle /var/tmp/.cauce-pty-bundle-argos.json` | dup argos | `docker exec ctrl-infra kill 3744846` |
| claw | 123331 | 74766s | `python3 /var/tmp/cauce-pty-agent-jarvis.py --bundle /var/tmp/.cauce-pty-bundle-jarvis.json` | dup jarvis (master: 61853, 197633s) | `docker exec claw kill 123331` |
| claw-miguel | 194667 | 74771s | `python3 /var/tmp/cauce-pty-agent-janus.py --bundle /var/tmp/.cauce-pty-bundle-janus.json` | dup janus (master: 175587, 197634s) | `docker exec claw-miguel kill 194667` |
| ws-humanizar | 3166703 | 77998s | `python3 /var/tmp/cauce-pty-agent-atlas.py --bundle /var/tmp/.cauce-pty-bundle-atlas.json` | dup atlas (master: 2867225, 197634s) | `docker exec ws-humanizar kill 3166703` |
| ws-humanizar | 3166890 | 77973s | `python3 /var/tmp/cauce-pty-agent-atlas.py --bundle /var/tmp/.cauce-pty-bundle-atlas.json` | dup atlas | `docker exec ws-humanizar kill 3166890` |
| ws-humanizar | 3176214 | 74789s | `python3 /var/tmp/cauce-pty-agent-atlas.py --bundle /var/tmp/.cauce-pty-bundle-atlas.json` | dup atlas | `docker exec ws-humanizar kill 3176214` |
| ws-humanizar | 3176430 | 74757s | `python3 /var/tmp/cauce-pty-agent-kratos.py --bundle /var/tmp/.cauce-pty-bundle-kratos.json` | dup kratos (master: 2867249, 197633s) | `docker exec ws-humanizar kill 3176430` |
| ws-humanizar | 3176313 | 74785s | `python3 /var/tmp/cauce-pty-agent-iza.py --bundle /var/tmp/.cauce-pty-bundle-iza.json` | **huérfano**: no hay `cauce-container-runtime` para iza; el pty-agent re-conecta al relay sin nada que forwardear | `docker exec ws-humanizar kill 3176313` |
| ws-prizma | 1726826 | 74736s | `python3 /var/tmp/cauce-pty-agent-socrates.py --bundle /var/tmp/.cauce-pty-bundle-socrates.json` | dup socrates (master: 1632194, 197633s) | `docker exec ws-prizma kill 1726826` |
| ws-zeus | 2453093 | 197633s | `python3 /var/tmp/cauce-pty-agent-zeus.py --bundle /var/tmp/.cauce-pty-bundle-zeus.json` | **huérfano**: no hay `cauce-container-runtime` para zeus; pty-agent solo en el contenedor | `docker exec ws-zeus kill 2453093` |

Pre-flight check antes de cada kill: que el PID siga vivo y su etime siga en la franja esperada
(puede que el supervisor lo re-lance y haya que re-evaluar).

## D. Alias OPERATIVOS (fuera del kill-list)

| alias | tenant | contenedor (host) | estado |
|---|---|---|---|
| heraclito | Jhon | agv2-jhon-heraclito-oc (local) | operativo — runtime + pty-agent vivos, sin duplicados |
| tales | Jhon | agv2-jhon-tales-oc (local) | operativo — runtime + pty-agent vivos, sin duplicados |
| salva | Isa | ws-isa (remoto, dockerHost=kratos) | operativo fuera de este host |
| argos (master) | Steven | ctrl-infra (local) | operativo — runtime + pty-agent master (3406530) vivos |
| kant | Steven | ctrl-infra (local) | operativo — pty-agent (3745728) vivo, runtime vive en pid (1607211) bajo argos |
| hegel (master) | Jhon | agv2-jhon-hegel-oc (local) | operativo — runtime + pty-agent master (285547) vivos |
| jarvis (master) | Steven | claw (local) | operativo — runtime + pty-agent master (61853) vivos |
| janus (master) | Miguel | claw-miguel (local) | operativo — runtime + pty-agent master (175587) vivos |
| atlas (master) | Miguel | ws-humanizar (local) | operativo — runtime + pty-agent master (2867225) vivos |
| kratos (master) | Miguel | ws-humanizar (local) | operativo — runtime + pty-agent master (2867249) vivos |
| socrates (master) | Steven | ws-prizma (local) | operativo — runtime + pty-agent master (1632194) vivos |

## E. Comandos de diagnóstico

Para revalidar antes de matar:

```bash
# 1. Censo por alias (cuenta pty-agents por contenedor)
for c in agv2-jhon-heraclito-oc agv2-jhon-tales-oc agv2-jhon-hegel-oc ctrl-infra claw claw-miguel ws-humanizar ws-prizma ws-zeus; do
  echo "=== $c ==="
  docker exec $c ps -eo pid,etimes,args 2>/dev/null | grep -E 'cauce-pty-agent|cauce-container-runtime' | grep -v grep
done

# 2. Confirmar que el PID candidato sigue vivo con el etime esperado
docker exec <container> ps -p <pid> -o pid,etimes,args

# 3. Confirmar que el runtime del mismo alias sigue vivo (no matar el master por error)
docker exec <container> ps -eo args | grep cauce-container-runtime | grep -v grep

# 4. Tras matar, re-contar y verificar que queda exactamente 1 pty-agent por alias
docker exec <container> ps -eo args | grep cauce-pty-agent | grep -v grep | awk '{print $2}' | sort | uniq -c

# 5. Confirmar que el supervisor no re-lanza el duplicado (esperar 60s y re-mirar)
sleep 60 && docker exec <container> ps -eo args | grep cauce-pty-agent | grep -v grep | awk '{print $2}' | sort | uniq -c

# 6. Verificar que no aparece nueva tormenta en el relay
docker logs --since=2m cauce-v3-prod-terminal-relay-1 2>&1 | grep -cE "agent_connected|agent_disconnected"

# 7. Estado de los alias fantasma (dedalo aparece pero no existe)
docker logs --since=1h cauce-v3-prod-terminal-relay-1 2>&1 | grep -oE '"alias":"[^"]+"' | sort | uniq -c
```

## F. Observaciones adicionales (no pedidas, pero relevantes)

1. **`dedalo` (tenant `Pablo`)**: aparece 3475 veces en el relay log con pares
   connect/disconnect, pero NO tiene contenedor (`docker ps -a` no lo lista),
   ni proceso, ni entrada en `container-aliases.json`. Es un **stale entry** en
   la tabla "last-known" del relay. No hay PID que matar — es solo dato residual.
   Acción sugerida fuera del kill-list: limpieza de la tabla interna del relay.

2. **`ws-zeus` con tmux `cauce-kratos`**: hay una sesión tmux huérfana
   `cauce-kratos` dentro de `ws-zeus` (created 2026-08-26 07:08). El alias `kratos`
   está declarado en `ws-humanizar`, no en `ws-zeus`. Probable sesión residual
   de una migración. No se incluye en kill-list porque el tmux-server no es un
   proceso Cauce — es metadata del usuario.

3. **Churn pareado pero alto**: ~99.7k pares connect/disconnect en 48h. Cada
   alias reconecta ~3-4 veces/minuto. No es runaway (1:1 pairing) pero indica
   que el supervisor del pty-agent se reinicia cíclicamente. Si tras matar los
   duplicados el churn NO baja, hay un bug latente en el supervisor (no en el
   launcher, que sí fue arreglado).

4. **Contenedor `ws-isa` no existe localmente**: el alias `salva` está marcado
   con `dockerHost: "kratos"` en el JSON, así que reside en otro host. Los
   3474 pares connect/disconnect que aparecen en el relay son legítimos y
   vienen por la red desde el host kratos.
