import assert from "node:assert/strict";
import test from "node:test";
import {
  entregaVencidaAlRecuperar, vencidaAlRecuperarError,
} from "../src/sdk/engine/recovery.js";
import type { InboxRecord } from "../src/sdk/durable-store/contracts.js";

/**
 * El caso REAL: kratos, 2026-09-07. Su entrega de las 23:40 murió en el bus a las 23:47 y el
 * reinicio del adaptador (02:25) la reejecutó: el arnés la contestó a las 02:58 con una
 * correlación muerta, el trabajo quedó huérfano y la entrega VIVA estuvo 176 min esperando.
 */
const MUERTA_A_LAS_23_47 = "2026-09-06T23:47:00.000Z";
const REINICIO_02_25 = new Date("2026-09-07T02:25:00.000Z");

test("una entrega recuperada que ya pasó su plazo de ACK se declara vencida", () => {
  assert.equal(
    entregaVencidaAlRecuperar({ ack_deadline_at: MUERTA_A_LAS_23_47 }, REINICIO_02_25),
    true,
  );
});

test("CONTROL: una entrega dentro de plazo NO se descarta", () => {
  assert.equal(
    entregaVencidaAlRecuperar(
      { ack_deadline_at: "2026-09-07T02:45:00.000Z" },
      REINICIO_02_25,
    ),
    false,
  );
});

test("CONTROL: en el borde exacto se considera vencida, y sin fecha NO se descarta nada", () => {
  assert.equal(
    entregaVencidaAlRecuperar({ ack_deadline_at: REINICIO_02_25.toISOString() }, REINICIO_02_25),
    true,
  );
  assert.equal(entregaVencidaAlRecuperar({}, REINICIO_02_25), false);
  assert.equal(
    entregaVencidaAlRecuperar({ ack_deadline_at: "no es una fecha" }, REINICIO_02_25),
    false,
    "ante una fecha ilegible se ejecuta: NO se descarta trabajo por una duda",
  );
});

test("el descarte NUNCA es retryable: el bus no va a aceptar esa entrega", () => {
  const error = vencidaAlRecuperarError({ delivery_id: "31595790-…" } as unknown as InboxRecord);
  assert.equal(error.code, "STALE_ON_RECOVERY");
  assert.equal(error.retryable, false);
  assert.match(error.message, /31595790/u);
});
