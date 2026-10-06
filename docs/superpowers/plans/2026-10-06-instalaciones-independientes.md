# Plan de implementación: instalaciones independientes de Cauce

> Ejecución: superpowers:subagent-driven-development, cuatro sectores disjuntos, revisión cruzada y commits únicamente del integrador.

**Objetivo:** instalar la misma distribución para cualquier empresa, sin reglas de Hospital en el núcleo.
**Arquitectura:** descriptor operativo por instancia y política tipada aprobada en BD/gateway. Hospital pasa a perfil opcional; el transporte durable conserva identidad, ACL y fencing.
**Tecnologías:** TypeScript/Zod, Python, Bash, PostgreSQL, Docker Compose y systemd.
**Especificación:** `docs/superpowers/specs/2026-10-06-instalaciones-independientes-design.md`.

## Restricciones globales

- Trabajo remoto en `/home/stev/cauce-independent-20261006`, rama `codex/company-instances-20261006`, base `08a7889`.
- El checkout local del dueño y sus cambios de UI quedan fuera de la escritura.
- No editar migraciones históricas, patches, credenciales, cuentas ni recursos productivos existentes.
- Defaults centrales compatibles; sin política: executor genérico, destinos implícitos ausentes, aviso opcional desactivado.
- Identidad de recursos nuevos acreditada por recibos; base/volumen desconocidos se rechazan antes de migrar o limpiar.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` y validación Ops antes de integrar; gate completo y release antes de desplegar.

## Foco de revisión

- Alias repetido entre instalaciones: selector y namespace inequívocos en CLI, unidades, sesiones y locks.
- Datos que parecen vacíos: no adoptar ni limpiar una base ajena.
- Dos instalaciones concurrentes: reserva única del host y rutas/puertos no solapados.
- Revocación entre claim y efecto: revalidar ACL, rol y egress; la prosa no autoriza.
- Cliente anterior: ningún campo nuevo sin capacidad negociada; workspace de Muse validado fuera del mensaje.

## Tarea 1 — Política confiable (agente de protocolo/store/gateway)

Rutas: `packages/protocol/**`, `packages/store/src/**`, sus tests y `services/gateway/**`; ningún SQL de migración.
Contrato compartido: `AgentBehaviorPolicyV1Schema`, tipo `AgentBehaviorPolicyV1`, campo opcional `behavior_policy`, capacidad `agent_behavior_policy_v1`.

```ts
type PolicyScope = { tenant_id: string; room_id: string; alias: string };
type PolicyModes = { coordination_mode: 'executor' | 'coordinator'; fanin_receipt_mode: 'technical' | 'human' };
```

- [ ] Añadir schema estricto con version/revision/scope, escalación `RecipientSchema` opcional y aviso issuer/session/egress.
- [ ] Persistir en configuración durable existente; lectura por consumidor, edición con operador/control/CAS/auditoría y validación de destinos.
- [ ] Añadir entrega solo con capacidad; probar ausencia, wire anterior, ámbito, CAS y revocación real de ACL/egress antes del efecto.
- [ ] Entregar nombres/exportaciones al agente SDK; revisar su consumo una vez terminado.

## Tarea 2 — SDK sin nombres de proyecto (agente SDK)

Rutas: `packages/adapter-sdk/**` exclusivamente; consume el contrato de Tarea 1.
Archivos de entrada: `src/bin/shared.ts`, `src/sdk/engine.ts`, `src/sdk/engine/praxis-supervision-notice.ts`, `src/harnesses/shared/prompt.ts`.

- [ ] Propagar la política tipada desde la entrega a los prompts y al tratamiento de recibos/avisos.
- [ ] Sustituir nombres de empresa, humano, coordinadores y workspace por política/configuración validada.
- [ ] Probar dos tenants/salas con alias iguales, body/origin falsificados, issuer/session/canal incorrectos, fence obsoleto y duplicados.
- [ ] Probar dos workspaces Muse arbitrarios permitidos y rechazo de retorno fuera del workspace.
- [ ] Revisar de forma independiente la Tarea 1; ejecutar suites SDK y exportaciones compiladas.

## Tarea 3 — Instalador por empresa (agente de operaciones)

Rutas: nuevos `ops/instances/common/**`, `ops/schemas/**`, `ops/scripts/export-fleet-snapshot.py` y tests nuevos de instancia en `ops/tests/`.
Interfaces Python: `load_instance_descriptor(path)` devuelve descriptor validado; `plan_instance(descriptor)` devuelve recursos y comandos sin mutar; `apply_instance(plan)` exige identidad/recibo y reserva exclusiva.

- [ ] Implementar schemaVersion/instanceId/companyId/release/codeRoot/inventoryRoot/paths/compose/endpoints/identityRefs/integrations.
- [ ] Reutilizar Compose y generadores; configuración de empresa sin enums centrales, codeRoot compartido de solo lectura, raíz de escritura propia.
- [ ] Implementar plan/install/status idempotentes, referencias a secretos, PKI propia y preflight de recursos/rutas/puertos incluyendo comodines.
- [ ] Implementar bootstrap fresh exclusivamente sobre almacenamiento nuevo acreditado; baseline exacto, transacción y actualización sin limpiar seeds.
- [ ] Probar reintento, drift, colisión concurrente y DB existente; revisar el sector namespace del integrador.

## Tarea 4 — Hospital como perfil opcional (agente integración Hospital)

Rutas: `ops/instances/hospital/**` y tests `ops/tests/test_praxis*`; nada en SDK, schemas ni scripts comunes.

- [ ] Mover identidades, workspaces, rutas, trackers y cantidades esperadas a configuración explícita validada.
- [ ] Consumir el instalador común; conservar las guardas de preview, evidencia, contexto, activación y permisos vigentes.
- [ ] Probar un proyecto de nombre/ruta/cantidades diferentes y configuración sin preview; no instalar timers productivos.
- [ ] Revisar aceptación de Tarea 3 con dos empresas y perfil de proyecto opcional.

## Tarea 5 — Namespace, integración y evidencia (integrador)

Rutas: `ops/scripts/generate-{container-units,units}.py`, `ops/scripts/{alias-lock-exec.py,container-adapter-supervisor.sh}`, `ops/cli/cauce`, helpers nuevos del namespace y `tests/integration/independent-instances*`.

- [ ] Derivar unidad/lock/session de `cauce-<instanceId>`; separar codeRoot de inventoryRoot y seleccionar instancia de forma explícita.
- [ ] Mantener generados centrales byte a byte; revisar Tarea 4 y cierre completo con otro agente.
- [ ] Ejecutar A/B en recursos desechables del mismo host: entrega/ACK/recuperación, PKI real, adjuntos y terminales; actualizar/parar A con tráfico B activo.
- [ ] Ejecutar gates del código exacto, registrar comandos/salidas y publicar la rama con su PR; integrar únicamente tras revisión y gates verdes.
- [ ] Verificar la instalación publicada contra recibos y retirar únicamente los recursos propios de prueba.
