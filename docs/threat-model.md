# Threat model — Cauce V3

## Activos y fronteras

PostgreSQL contiene payloads, topología, leases, ACKs, jobs y auditoría. Gateway
es la frontera HTTP/WS; consola y adapters son clientes no confiables.
Dispatcher y gateway coordinan por filas/leases PostgreSQL. Prometheus/OTel solo
reciben agregados sin tenant/payload.

## Amenazas y controles implementados

| Amenaza | Control actual |
|---|---|
| Suplantación de actor/tenant/session/channel | Payload publish strict y gateway deriva identidad desde `Principal`; hello WS se compara con el principal. |
| Dev auth en producción | `DevOnlyAuthProvider` es rechazado con `NODE_ENV=production`; sin provider productivo gateway no arranca. |
| Segundo consumer / split brain | Lease por `(tenant,alias)`, epoch monotónico y fencing de heartbeat/claim/ACK. |
| Confused deputy multi-tenant | Membresía, ACL default-deny y facades filtradas por principal. |
| Replay/idempotency mutation | Key ligada a hash semántico; constraints deduplican delivery/outbox. |
| ACK duplicado/viejo/perdido | Rango monotónico, owner+epoch, historial ACK, timeout/retry y DLQ. |
| Caída entre persistencia y push | PostgreSQL es durable; `LISTEN/NOTIFY` solo acelera y outbox wake reintenta. |
| Job no-op o poison kind | Registry explícito por kind; completar requiere handler resuelto y ejecutado. Kind desconocido pasa atómicamente a `dead`+DLQ. En producción solo existe `system.database.probe`; QA se registra únicamente con `NODE_ENV=test`. |
| Starvation | Jobs tienen lanes `interactive|batch`, prioridad y burst interactivo acotado. |
| Browser como autoridad | Cookie same-origin, body allowlisted, sin storage de tokens. Mutaciones requieren snapshot RBAC exacto; permiso ausente/endpoint faltante queda UNKNOWN y bloqueado. Estados fuera de enum quedan UNKNOWN. |
| Terminal como broker implícito | Ultimate Terminal es plugin cliente lazy, same-origin, sin query credentials, y exige plugin id, capability `terminal.pty.client` y permiso `ultimate-terminal.connect`. |
| DB sin cifrar en producción | Readiness exige modo TLS y confirma `pg_stat_ssl.ssl=true`; probes Compose y backup/restore aplican la misma política. `verify-full` es la recomendación operativa. |
| Runtime con toolchain | Imagen final usa usuario `node`, JS compilado y dependencias production; comandos son `node .../dist/main.js`, sin tsx/devDependencies. |
| Observabilidad engañosa | Dispatcher y `outbox-metrics` consultan PostgreSQL en cada scrape y emiten gauges para queue/retry/DLQ/leases y wake/outbox/relay; si falla, la serie `*_query_success=0` evita inventar ceros. Gateway expone progreso y resultados agregados de su wake pump en un listener interno sin labels de identidad; se alerta tanto target caído como loop vivo pero estancado y ACK cercado. |
| QA mocked acreditado como real | Reportes separan `protocol-double`, mocked y authentic restart. Evidencia real/restart exige cero skips; un perfil restart mal configurado falla antes de ejecutar y conserva PID/container/timestamps cuando aplica faults. |
| XSS/estilos dinámicos de xterm | CSP mantiene scripts y style elements en `self`; solo `style-src-attr 'unsafe-inline'` permite la geometría dinámica de xterm. |
| Credencial de un agente a otro por el bus | Traspaso sellado: el emisor cifra en su propio proceso (X25519 + HKDF-SHA256 + AES-256-GCM), el gateway guarda bytes que no puede abrir, el destinatario reclama **una sola vez** y por `POST` (un `GET` lo quemaría un prefetch o un `<img src>`), la caducidad es obligatoria y como mucho 24 h (CHECK de la base), el emisor puede revocar, y cada mutación confirma su fila y su fila de auditoría en **una** transacción. La auditoría lleva una lista blanca: etiqueta, tenant y alias del destinatario, `sealing_key_id`, motivo y la sha256 del ciphertext recortada a 16 hex; jamás el valor ni los bytes sellados. Publicar la clave pública también se audita, porque decide a quién van dirigidos todos los traspasos futuros de ese alias. Ver [ADR-007](adr/007-traspaso-sellado-de-secretos.md). |
| Un emisor llenando el buzón de otro agente | Un traspaso lo crea el **emisor** contra un destinatario que no lo pidió, así que el sellado cuenta los traspasos vivos del destinatario **dentro del propio `INSERT`** y rechaza por encima de 32 con un 429 `too_many_handoffs` y su fila `secret.denied` (escrita fuera de la transacción, que si no se iría con el rechazo). El listado devuelve como mucho 20 por página con cursor keyset: quién publica decide cuántos traspasos existen, así que no puede decidir además el tamaño de la respuesta. La cota es por destinatario, y eso deja que un emisor ruteable ocupe los huecos de uno honesto: se ve en la auditoría y ningún hueco dura más de 24 h. |
| Mensaje de error del plano de secretos como oráculo | Lista blanca en la respuesta: sólo los errores que el plano levanta a propósito, más los de autenticación y autorización —cuyo texto habla de quien llama, nunca del despliegue—, salen con texto. Un fallo de driver, un pool muerto o un `TypeError` colapsan a un 500 opaco: un error de conexión lleva host y puerto de la base, y un fallo interno no es un error del cliente que haya que pedirle que deje de reintentar. La validación va toda por `safeParse`, así que ningún texto lanzado por un esquema escapa. |
| El claro del secreto saliendo por la respuesta del agente | El punto de suelta del adaptador es mecánico, no una frase del prompt: directorio de secretos propio y denegado por prefijo **antes** de que el inliner lea nada, retención por sha256 de los bytes —también los de un `data:` que el modelo escribió él mismo, que se decodifica y se hashea—, y sustitución del valor literal en respuesta, cuerpos delegados, `notify` y los tres campos de texto libre de un artifact. La huella y el valor se capturan **al materializar el secreto**, no releyendo el fichero al armar el ACK: releerlo dejaba que un `rm` o un `chmod` del propio agente desarmara las dos comprobaciones en silencio. **Lo que no cubre** está abajo, en riesgos pendientes. |
| Credencial de gateway inmortal | `expires_at` es **obligatorio** en todo registro de identidad (token y mTLS): un registro sin él ya no se acepta, el fichero entero se rechaza al leerlo. La rotación se publica por `rename` atómico y el proveedor reresuelve la ruta por petición, así que altas y revocaciones llegan sin reiniciar. |
| Secretos que quedan en claro en la base | Redacción en el punto único de publicación del gateway (`CAUCE_REDACT_PUBLISH`, encendida por defecto) con las reglas compartidas de `@cauce/protocol`, aplicada por **un solo ayudante** desde las dos patas de la publicación en dos fases, para que el hash semántico salga de los mismos bytes en ambas. El cuerpo delegado de agente a agente se redacta en el store, que es un camino de publicación que el gateway no ve. El ingreso del puente tiene su propio interruptor, apagado por defecto. Lo que la redacción no alcanzó a recorrer se registra con motivo y recuento en vez de pasar en silencio, y son **tres** cotas: longitud de un valor (1 MiB), presupuesto de nodos (100 000) y presupuesto agregado de caracteres por cuerpo (4 MiB). Esta última es la única que acota el coste total —un cuerpo con muchos valores grandes multiplicaba las otras dos y compraba segundos del bucle de eventos compartido— y el informe nombra **todas** las cotas que saltaron, no sólo la primera. Cada regla tiene además sus cuantificadores acotados, para que la coincidencia más ancha posible quepa en el solape de dos ventanas y un texto cebado no dispare retroceso. |
| Bytes de adjuntos que se acumulan sin límite | Tres podas, ninguna borra filas: la copia durable de `deliveries.result` pierde los bytes inline al escribirla y conserva la identidad del artifact (`inline_artifacts_omitted`); un `dead_letters` guarda el cuerpo sin `attachments_v1` y con `attachments_omitted`; y un barrido por edad quita `attachments_v1` de `messages.body` dejando `attachments_pruned`. La poda del `dead_letters` es **un único fragmento SQL compartido por sus tres escritores** —ACK terminal, vigilante y cancelación de operador—, porque una copia escapando por cualquiera de ellos vuelve inútiles a las otras dos: nada poda `dead_letters` y la consola lo lee para siempre. Su guarda es `jsonb_typeof(...)='array'`, no la presencia de la clave: `jsonb_array_length` sobre algo que no es un array aborta la transacción del ACK y deja la entrega reintentando eternamente. |

## Riesgos y bloqueos pendientes

- OIDC/JWKS, mTLS, token-file y `/v3/console/access` existen, pero cada entorno
  debe aportar certificados/identity maps/provider correctos y evidenciar
  negativos/rotación. Configuración incompleta falla cerrado.
- El worker `origin_relay` existe, pero el provider firmado y su receiver
  idempotente son dependencias externas. `sent` solo se acredita con `sent_at`;
  Telegram y relay genérico no pueden competir por el mismo adapter.
- Los manifests de flota describen wrappers auténticos por PATH. No convierten
  los protocol doubles ni el adapter CLI bundled en autenticación productiva;
  WSS/token/client-cert deben verificarse en el wrapper del entorno.
- Retención de observabilidad: barrido acotado del dispatcher sobre `delivery_acks` (renovaciones
  6 h, resto 14 días) y `audit_events` (renovaciones 6 h, resto 30 días, y sólo sobre una **lista
  blanca** de acciones que son telemetría), en lotes de 5 000 filas por tabla.
- Retención de los bytes de adjuntos en `messages.body`, **cableada** en la fase `retention` del
  dispatcher: el arranque construye la política y la fase la ejecuta, con una línea de log cuando la
  poda toca algo. Ventana por defecto de **30 días** (`DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS`).
  Quita la clave `attachments_v1` y deja `attachments_pruned` con cuántos ficheros había, para que la
  consola pueda decir «cuerpo purgado por retención» en vez de mostrar un cuerpo que parece roto.
  **Nunca borra una fila ni anula el cuerpo**: el barrido de cadenas lee `correlation.root_message_id`
  y `type`, el fan-in lee `text` y el techo de lease lee `timeout_ms`, y quitar una clave los deja
  intactos por construcción. Es idempotente: un segundo barrido no encuentra nada y no pisa la
  cuenta.
- Esa poda tiene **cota y cadencia propias**, nunca las de la retención de observabilidad: **50
  filas** (`DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH`) cada **hora**
  (`…_INTERVAL_MS`). Son dos órdenes de magnitud por debajo de las 5 000 de la otra retención a
  propósito: aquella dimensiona borrados de filas estrechas de ACK y auditoría, ésta reescribe
  cuerpos de `messages` que llevan hasta 10 MB de ficheros cada uno, y a 5 000 un solo tic empujaría
  decenas de GB de WAL sobre la tabla más caliente de la base.
- La ventana **debe superar** el horizonte del barrido de cadenas (`CHAIN_MAX_AGE_MS`, 48 h por
  defecto) y se rechaza al configurarla si no lo hace: una cadena que el vigilante todavía puede
  reabrir perdería los ficheros de sus ramas semanas después, sin nada en los logs que conecte las
  dos cosas. La comprobación sólo corre **mientras la poda está encendida**: subir
  `CHAIN_MAX_AGE_MS` no puede dejar sin arrancar a un dispatcher que no barre nada.
- Esa poda **no tiene índice todavía**: el único índice sobre `messages(created_at)` es parcial
  sobre `origin IS NOT NULL` y no hay GIN sobre `body`, así que el estado estacionario —nada que
  podar, luego el `LIMIT` nunca corta— es un recorrido secuencial de `messages` por ejecución. Por
  eso la cadencia propia es lenta. El índice parcial `created_at WHERE body ? 'attachments_v1'`
  queda pendiente.
- Ese barrido **acorta la exposición, no la termina**: el `pg_dump` nocturno se sincroniza a un NAS
  append-only que nunca borra en el remoto, así que ninguna poda sobre la base viva alcanza las
  copias off-site.
- Siguen sin existir particionado de ACK/audit, rate limits/cuotas y cifrado de payload a nivel de
  aplicación.
- El traspaso sellado **no puede entregar la credencial que revive a un adaptador muerto**:
  reclamar un traspaso exige un turno vivo del destinatario, y un adaptador sin credencial no
  tiene turno. La vía del operador fuera de banda sigue siendo el canal de arranque.
- **El destinatario ve el claro, y eso es el punto del canal.** Lo que el sistema garantiza es que
  Cauce nunca escribe el valor fuera del fichero `0600` del turno, y que el punto de suelta retiene
  por ruta y por sha256 el fichero del secreto —incluida la copia en un `data:` que el modelo armó
  él mismo— y borra el **valor literal** de la respuesta, de los cuerpos delegados, de los `notify`
  y de los tres campos de texto libre de un artifact. Lo que **no** garantiza: que el modelo no
  reescriba el mismo secreto partido, recodificado o parafraseado. Ni la sustitución literal ni la
  huella de los bytes exactos alcanzan a eso. Ese texto llega a
  `messages.body`, y de ahí a `dead_letters`, a la consola y a los volcados off-site append-only,
  que es un camino de ida. La redacción de publicación sólo reconoce familias conocidas: una
  contraseña de base de datos o un token a medida no encajan en ninguna.
- Hoy **ningún binario de arnés cablea el transporte** del traspaso, así que la mitad receptora
  existe en el SDK y no en un adaptador en marcha.
- La rotación make-before-break de identidades está permitida por el gateway —acepta dos
  registros vivos del mismo principal y caduca cada uno por su fecha— y **bloqueada en los
  scripts de aprovisionamiento**, que rechazan una segunda identidad mTLS para el mismo
  `(tenant, alias)` y exigen revocar antes de registrar. Ese desbloqueo vive en `ops/`.
- La redacción recorre **sólo valores de texto**: `content_base64` está excluido a propósito, así
  que un `.pem` enviado como fichero se guarda literal en `messages.body`.
- El modo `sslmode=require` cifra pero no valida identidad del servidor;
  producción debe usar `verify-full` y CA gestionada fuera del repositorio.
- HA administrada (failover PostgreSQL, LB multi-gateway, RPO/RTO) no está
  acreditada por Compose. Ver `ops/runbooks/ha.md`; hasta completar ese gate la
  arquitectura es piloto, no producción HA.
