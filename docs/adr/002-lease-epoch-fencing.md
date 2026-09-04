# ADR-002: Consumer único mediante lease, epoch y fencing

**Estado:** aceptado.

La identidad de consumo es `(tenant_id, alias)`. Un `instance_id` distinto no puede tomar el lease
vivo por la vía normal. Una reconexión reanudable del mismo `instance_id` conserva el `epoch` y
rota siempre el `connection_token`. Heartbeat, claim y liberación exigen el token vigente; el
socket anterior queda cercado aunque comparta `instance_id` y `epoch`.

Un takeover posterior al vencimiento incrementa el `epoch` y rota el `connection_token`. Cada
delivery conserva además `instance_id`, `epoch`, `attempt` y `claim_token`; una transición nueva o
renovación debe coincidir con esa identidad y con un lease vigente. El replay exacto de un ACK ya
aplicado puede devolver `duplicate` sin mutar estado aunque el lease haya vencido.

La presencia no es un flag: se deriva exclusivamente de `lease_until > now()`, renovado por heartbeat.
