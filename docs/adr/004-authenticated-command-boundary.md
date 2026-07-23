# ADR-004: identidad y origin solo desde contexto autenticado

**Estado:** aceptado.

El schema `AuthenticatedPublishSchema` es el único payload HTTP/console y excluye `tenant_id`, `actor_alias`, `request_id`, `trace_id`, session, channel y origin. Fastify usa un `AuthProvider` para obtener `Principal`; el gateway genera correlación y arma el `PublishMessage` interno. Campos extra se rechazan, no se silencian.

Hello WS declara tenant/alias para bind del consumer, pero no concede autoridad: debe coincidir con el principal del upgrade. El proveedor dev usa headers solo con flag explícito y es inválido en producción. Producción ofrece OIDC/JWKS, mTLS directo (sin headers de certificado) y piloto token-file por hash; configuración incompleta, token-file ilegible o TLS ausente fallan cerrados.

Consecuencia: adapters de ingress que necesiten return route deben autenticarla en su provider/proxy; nunca reenviarla como autoridad desde JSON arbitrario.
