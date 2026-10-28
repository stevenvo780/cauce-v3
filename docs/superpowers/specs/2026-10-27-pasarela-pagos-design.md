# Pasarela de pagos con Mercado Pago

## Intención

Cobrar Cauce a empresas nuevas con suscripción mensual de Mercado Pago. Tres formas de pago:

| Plan | Qué incluye | Precio (USD/mes) | Límite de agentes |
|---|---|---|---|
| `gestionado` | Nosotros ponemos y probamos las cuotas de IA y hospedamos los agentes | 100 por agente; se recomienda 3 (300) | la cantidad comprada (1–50) |
| `hotel_20` | El cliente pone sus cuotas y sus ordenadores; paga la red de interconexión | 150 | 20 |
| `hotel_50` | Igual que `hotel_20` | 300 | 50 |
| `espacio` | El cliente pone cuotas y ordenadores; paga por espacio de trabajo | 40 por espacio | 5 por espacio comprado |

Decisión propia (precio por espacio): un espacio típico tiene 3–5 agentes (hoy: Steven 8, Miguel 6, Isa 1, Hospital 3).
El Hotel a 20 agentes sale a 7,5 USD por agente; 5 × 7,5 = 37,5, redondeado a 40. Cuatro espacios (160) ya cuestan más
que `hotel_20` (150), así que el plan por espacio solo conviene a equipos pequeños, que es su propósito.

## Objetivos

- Un administrador de empresa elige plan en la consola, paga en Mercado Pago y vuelve con el plan activo.
- El estado de la suscripción se toma siempre de la API de Mercado Pago, nunca del cuerpo del aviso (webhook).
- Una empresa sin plan activo y no exenta no puede crear agentes; con plan, no puede pasar su límite.
- Cancelar la suscripción desde la consola.

## Fuera de alcance

Facturación electrónica, impuestos, cupones, prorrateo, cambio de plan a mitad de ciclo (se cancela y se contrata
otro), cobro por uso de cuotas, y forzar dónde se hospedan los agentes según el plan (solo se registra el tipo).

## Anti-objetivos

- Romper o limitar las empresas actuales: Humanizar y Praxis quedan **exentas** (migración marca exentas a todas las
  empresas existentes).
- Guardar o registrar el token de Mercado Pago en el repo, en la base de datos o en logs.
- Activar un plan por un aviso sin verificar su firma ni sin releer la suscripción en Mercado Pago.

## Restricciones

- Secretos por fichero, como `DATABASE_URL_FILE`: `MERCADOPAGO_ACCESS_TOKEN_FILE` y `MERCADOPAGO_WEBHOOK_SECRET_FILE`.
  Si falta cualquiera, la facturación está **desactivada**: las rutas responden `503 {"error":"billing_unconfigured"}` y
  la consola muestra «Pagos sin configurar». Los pone el dueño; ningún agente los toca.
- Precios en USD en código. Mercado Pago cobra en la moneda de la cuenta vendedora: `BILLING_CURRENCY` (por defecto
  `COP`) y `BILLING_USD_RATE` (unidades de moneda por USD, obligatorio si la moneda no es `USD`; sin él, facturación
  desactivada). El importe enviado es `round(usd × rate)`.
- `BILLING_PUBLIC_URL` (por defecto `https://consola.humanizar.tech`) para `back_url` y la URL del aviso.
- Migración nueva `096_billing.sql` + `down/096_billing.sql`; no se edita ninguna migración aplicada.
- Reglas del repo: código en inglés, docs en español, comentarios sin narrativa, commits por pathspec.

## Cómo (decidido)

### Datos (`packages/store`)

- `companies`: columna nueva `billing_exempt boolean NOT NULL DEFAULT false`; la migración pone `true` en todas las
  filas existentes.
- Tabla `billing_subscriptions`: `id uuid pk`, `company_id` (fk companies), `plan text` (check en los 4 planes),
  `quantity int` (≥1; agentes para `gestionado`, espacios para `espacio`, 1 para hotel), `agent_limit int`,
  `amount_usd numeric(10,2)`, `currency text`, `amount_local numeric(14,2)`, `status text` (check:
  `pending|authorized|paused|cancelled`), `provider text default 'mercadopago'`, `provider_subscription_id text unique`,
  `checkout_url text`, `created_by text`, `created_at`, `updated_at`, `last_event_at`. Índice único parcial: una sola
  suscripción `authorized` o `pending` por empresa.
- Tabla `billing_events`: `id bigserial`, `provider_event_id text`, `request_id text`, `topic text`,
  `subscription_id uuid null`, `payload jsonb`, `received_at`, único `(provider_event_id, topic)` para idempotencia.
- Módulo `billing.ts` en el repositorio con funciones puras de precio (`planQuote(plan, quantity)` → `{amount_usd,
  agent_limit}`) y de acceso a datos: crear suscripción pendiente, adjuntar id/URL del proveedor, aplicar estado
  releído, registrar evento idempotente, leer el plan vigente de una empresa y `companyAgentAllowance(company)` →
  `{exempt, limit, used}` (usados = agentes con `enabled` o `lifecycle_state<>'retired'` y `retired_at IS NULL` y
  `purged_at IS NULL`).

### Pasarela (`services/gateway`)

- Cliente Mercado Pago (`fetch`, sin SDK): `POST /preapproval` con `reason`, `external_reference` (= id interno de la
  suscripción), `payer_email` (correo de la sesión), `back_url`, `auto_recurring {frequency:1, frequency_type:'months',
  transaction_amount, currency_id}`, `status:'pending'`; `GET /preapproval/{id}`; `PUT /preapproval/{id}
  {status:'cancelled'}`. Cabecera `Authorization: Bearer <token>` y `X-Idempotency-Key` = id interno.
- Rutas de consola (sesión de administrador de la empresa seleccionada, mismo control que el resto de rutas de
  administración de empresa):
  - `GET /v3/console/billing` → `{configured, exempt, plans:[{plan, price_usd, unit, agent_limit_per_unit,
    recommended_quantity?}], currency, usd_rate, subscription|null, allowance:{limit, used}}`.
  - `POST /v3/console/billing/checkout {plan, quantity}` → crea la suscripción pendiente, llama a Mercado Pago y
    devuelve `{checkout_url}`. 409 si ya hay una `authorized` o `pending`.
  - `POST /v3/console/billing/cancel` → cancela en Mercado Pago y relee.
  - `POST /v3/console/billing/refresh` → relee el estado en Mercado Pago (para la vuelta desde el pago).
- Aviso público `POST /v3/billing/mercadopago/webhook`: verifica `x-signature` (`ts=…,v1=…`; HMAC-SHA256 con el
  secreto sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, comparación en tiempo constante, `ts` a menos de
  10 min), registra el evento de forma idempotente, y para `subscription_preapproval` relee `GET /preapproval/{id}` y
  aplica el estado a la suscripción cuyo `external_reference` coincide. Responde 200 rápido aunque el tema no interese;
  401 si la firma falla. Sin sesión, con límite de tamaño de cuerpo.
- El límite se aplica donde se crean agentes (creación en el registro y operación de flota `create`): si la empresa no
  está exenta y `used >= limit` (o no hay suscripción `authorized`), `402 {"error":"plan_limit_reached"}`.
- Añadir las rutas a la matriz de aislamiento de rutas (`security/route-isolation-matrix.ts`) y la del aviso a la
  lista de rutas públicas permitidas por el proxy de la consola (`deploy/console/nginx-console-tls.conf` u homólogo
  que filtra `/v3/*`).

### Consola (`console`)

- Sección nueva de Ajustes `plan` («Plan y pagos») en `sections.ts`.
- Muestra el plan vigente y su estado, los agentes usados/límite, y tarjetas de los cuatro planes; `gestionado` con
  selector de cantidad (1–50, por defecto 3, sello «Recomendado» en 3); `espacio` con selector de espacios (1–10).
  Precio en USD y equivalente en la moneda local.
- Botón «Pagar con Mercado Pago» → `checkout` → `window.location.assign(checkout_url)`.
- Al volver (`/config?seccion=plan&pago=vuelta`) llama a `refresh` y muestra el estado.
- «Cancelar suscripción» con confirmación en la propia página (sin `window.confirm`).
- Empresas exentas: aviso «Esta empresa no paga plan» y sin botones de pago. Sin configurar: «Pagos sin configurar».

## Lo que decide quien construye

Nombres internos, reparto en ficheros, forma exacta de los tests, textos menores de la interfaz.

## Pruebas mínimas

Precios y límites (`planQuote`), firma del aviso (válida, alterada, caducada), idempotencia del aviso, transición de
estado solo tras releer en Mercado Pago (cliente simulado), 402 al pasar el límite, exención, consola: render de planes,
flujo de pago con cliente API simulado.
