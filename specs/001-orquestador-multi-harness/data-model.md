# Data Model (conceptual — describe lo existente, no propone migraciones)

**Spec**: [spec.md](spec.md). Fuente: `docs/arquitectura.md` + inspección del
árbol (WF2). Sin `down` ni `up` nuevos en este spec.

## Entidades

- **agents**: identidad de cada agente (tenant, alias, harness, `enabled`,
  credencial vigente). PK alias. Es la verdad de la flota con `memberships`.
- **memberships**: qué alias habla con qué alias y con qué alcances.
- **messages**: un envío lógico (emisor, cuerpo, destinatarios).
- **deliveries**: una fila por destinatario de cada mensaje. 8 estados
  (`DeliveryState`); columnas de fencing: `claim_token`, `epoch`, intento,
  `ack_deadline`.
- **claim (efímero, no tabla)**: `LeaseResult` (epoch + token) y
  `LiveDeliveryClaim` (claim_token + intento + ack_deadline). Vive en el
  gateway/consumidor; la BD guarda el estado cercado.
- **context_revisions**: revisiones de contexto nativo por harness con
  generación de contenedor (larga: proceso; corta: encarnación).
- **outbox / auditoría / secrets**: pendientes de decisión de poda (FR-012,
  FR-013); el modelo los marca acotables, no acotados.

## Reglas invariantes

1. Nada sin fila en `agents` existe para el sistema.
2. Un `delivery` tiene como máximo un claim vivo; el segundo reclamante
   recibe 409.
3. `enabled=false` rechaza leases nuevos dentro de la transacción; el lease
   vigente termina, no se renueva.
4. Todo lo derivado (alias runtime, manifests, units, PKI) se regenera desde
   BD + `flota.json`; la deriva falla `validate.sh`.
