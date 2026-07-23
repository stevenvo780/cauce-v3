# ADR-002: Consumer único mediante lease, epoch y fencing

**Estado:** aceptado.

La identidad de consumo es `(tenant_id, alias)`. Un `instance_id` distinto no puede tomar un lease vivo. Una reconexión del mismo instance o un takeover posterior al vencimiento incrementa `epoch`; cada claim, heartbeat y ACK exige la tupla completa y lease vigente. Así, un socket viejo no puede confirmar trabajo después de ser reemplazado.

La presencia no es un flag: se deriva exclusivamente de `lease_until > now()`, renovado por heartbeat.
