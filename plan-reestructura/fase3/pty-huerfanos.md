# Kill-list de pty-agents huérfanos (censo 2026-08-27 04:26 UTC — NO ejecutado)

Diagnóstico verificado: 24 procesos `cauce-pty-agent-*.py` en 10 contenedores para 10 clientes `docker exec` → 14 huérfanos. Todos los procesos de un alias comparten certificado → el relay los expulsa mutuamente (`superseded`) en bucle: **502 conexiones/min medidas**, ley exacta churn ≈ (N−1)×106 conex/3min. Tres oleadas de lanzamiento (25-ago 13:54, 26-ago 23:07, 27-ago 00:01) explican los N=4 de argos/atlas.

**Seguridad verificada:** ningún agente tiene procesos hijo; `docker exec` entra con el mismo uid (1000) que los procesos (no hace falta root); las 2 sesiones tmux humanas no cuelgan de ningún agente; los huérfanos no pueden auto-resucitarse (sus bundles ya no están en disco).

## BLOQUE A — los 12 que alimentan el bucle (ejecutar con el dueño; forma con guarda anti-reuso de PID)

```bash
docker exec ctrl-infra   sh -c 'ps -o args= -p 3406530 | grep -q cauce-pty-agent-argos.py    && kill 3406530'
docker exec ctrl-infra   sh -c 'ps -o args= -p 3736363 | grep -q cauce-pty-agent-argos.py    && kill 3736363'
docker exec ctrl-infra   sh -c 'ps -o args= -p 3736489 | grep -q cauce-pty-agent-argos.py    && kill 3736489'
docker exec ws-humanizar sh -c 'ps -o args= -p 2867225 | grep -q cauce-pty-agent-atlas.py    && kill 2867225'
docker exec ws-humanizar sh -c 'ps -o args= -p 3166703 | grep -q cauce-pty-agent-atlas.py    && kill 3166703'
docker exec ws-humanizar sh -c 'ps -o args= -p 3166890 | grep -q cauce-pty-agent-atlas.py    && kill 3166890'
docker exec ws-humanizar sh -c 'ps -o args= -p 2867249 | grep -q cauce-pty-agent-kratos.py   && kill 2867249'
docker exec ws-prizma    sh -c 'ps -o args= -p 1632194 | grep -q cauce-pty-agent-socrates.py && kill 1632194'
docker exec claw         sh -c 'ps -o args= -p 61853   | grep -q cauce-pty-agent-jarvis.py   && kill 61853'
docker exec claw-iza     sh -c 'ps -o args= -p 6243    | grep -q cauce-pty-agent-iza.py      && kill 6243'
docker exec claw-miguel  sh -c 'ps -o args= -p 175587  | grep -q cauce-pty-agent-janus.py    && kill 175587'
docker exec agv2-jhon-hegel-oc sh -c 'ps -o args= -p 285547 | grep -q cauce-pty-agent-hegel.py && kill 285547'
```

Orden: de más antiguo a más reciente, alias por alias, empezando por argos y atlas (64% del churn). **NO TOCAR** los 10 legítimos (lista completa en el censo; tras el Bloque A el censo debe dar exactamente 10, uno por alias). Nota `iza`: el contenedor correcto ES `ws-humanizar` (verificado contra `container-alias-query.py`); el de `claw-iza` es huérfano de un mapping viejo.

## Verificación antes/después

```bash
# ANTES (línea base ya tomada): 985 agent_connected / 2 min
docker logs cauce-v3-prod-terminal-relay-1 --since 2m | grep -c 'agent_connected"'
# DESPUÉS (esperar >2 min tras el último kill): ESPERADO ≈ 137, todo de dedalo+salva (host remoto)
# Criterio real de éxito: ningún alias LOCAL en:
docker logs cauce-v3-prod-terminal-relay-1 --since 2m | grep -o '"alias":"[a-z]*"' | sort | uniq -c | sort -rn
# Y una sesión TUI abierta desde la consola debe sobrevivir >60 s.
```

## BLOQUE B — opcional (D4): 2 singletons con churn cero, alias ya fuera del mapa de flota
`docker exec agv2-jhon-heraclito-oc kill 474171` · `docker exec agv2-jhon-tales-oc kill 74697`

## Residuo esperado y causa raíz
- `dedalo` y `salva` bucléan desde OTRO host (~68 conex/min irreducibles desde aquí) → mismo censo allí (D5).
- Causa raíz en `ops/pty-agent/cauce-pty-launcher.sh:783-801` (flock del host muere con el cliente; el proceso del contenedor sobrevive; sin reconciliación). Arreglo en `pre-ventana-codigo.md` §6 — **sin él, el bucle reaparece en el próximo rollout**.
