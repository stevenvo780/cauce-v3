# DEMO PROBETA — flota-como-datos, prueba de efecto real (28-08, ejecutada por el integrador contra prod)

Criterio de cierre de `plan-reestructura/flota-como-datos.md` §8: alta y baja de un agente tocando SOLO BD + CLI, todo lo demás derivado. **RESULTADO: SUPERADA, con 2 hallazgos reales que ya están corregidos y 1 hallazgo de seguridad asignado.**

| Paso | Qué se hizo | Resultado |
|---|---|---|
| 1 Alta | 2 INSERT en prod (`agents`, `memberships`) — nada más | ✔ |
| 2 Export | `export-fleet-snapshot.py` | ✔ `git diff` = **solo `ops/flota.json`** |
| 3 Regenerar | `regenerate-fleet.sh` | ✔ aparecieron solos: `manifests/probeta.yaml`, 2 units, `configs/probeta.env.example`, entrada en json (15) y telegram |
| 4 Gates | digest+SUMS, G-SNAP, physical-fleet-gate, calidad | ✔ "15 enabled aliases", todo verde |
| 5 Aprovisionar | cert `agent-probeta` (CA real) + registro mTLS (21 identidades) + token 0400 | ✔ — destapó **hallazgo A** |
| 6 **Efecto real** | hello mTLS por `wss://100.64.0.11:8443/v3/ws` | ✔ **`hello_ack epoch=1`** + fila en `connection_leases` |
| 7 Baja | `enabled=false` → re-export (`retired: [probeta]`) → regenerar **purgó** manifest+unit systemd → revoke (hash+token eliminados) → DELETE final → árbol de vuelta a 14, digest verde | ✔ — destapó **hallazgos B y C** |

## Hallazgos (la demo hizo su trabajo)
- **A (corregido, `6ae921b3`)**: las libs de credenciales exigían "dueño == usuario efectivo"; prod tiene propietarios mixtos (`pki/` 0700 root, `identities/` de stev) → ningún usuario podía correr las 3 piezas. Relajado a "root o dueño" (root ya preserva propiedad con `fchown`).
- **B (corregido)**: `generate-container-units.py` NO purgaba units huérfanas (la de `probeta` sobrevivió a la baja); `generate-units.py` sí. Añadida la misma purga.
- **C — SEGURIDAD, asignado a codex-1**: tras `UPDATE agents SET enabled=false`, el gateway **siguió aceptando el hello de probeta** (`hello_ack epoch=2`). El `/v3/ws` autoriza solo por cert mTLS; `authority.ts` filtra `agent.enabled` para ENRUTAR, pero el hello/lease no lo consulta. Un agente dado de baja en la BD puede seguir conectándose hasta que se le revoca el cert. Contradice la promesa del diseño ("primero BD: el gateway deja de autorizar").
- Menor: `register-agent-identity.py` no tiene modo de baja (la identidad mTLS se quitó a mano, atómico); `cauce retirar` debería encadenarlo.

## Todo fichero cambiado tiene generador: SÍ — el único diff manual de toda la demo fueron los fixes A y B.
