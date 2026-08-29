import { describe, expect, it } from 'vitest';
import { visibleQueue } from './facades.js';
import type { Principal } from './auth.js';

const principal = {
  tenant_id: 'Steven', alias: 'kant', session_id: 's', channel: 'console',
  roles: ['operator'], permissions: ['read'], epoch: 1,
} as unknown as Principal;

function fila(state: string) {
  return { recipient_tenant: 'Steven', recipient_alias: 'kant', state };
}

describe('visibleQueue', () => {
  it('cuenta failed como dead letter, igual que el store y la tabla', () => {
    // Regresión: antes `else if (row.state === "dead")` dejaba `failed` fuera y la tarjeta
    // «Dead letters» subcontaba respecto al store, la tabla y la tira «Muertas» de Mensajes.
    const out = visibleQueue({ items: [fila('dead'), fila('failed'), fila('failed')] }, principal);
    expect(out.dead).toBe(3);
  });

  it('separa pending/retry/dead correctamente', () => {
    const out = visibleQueue({
      items: [fila('pending'), fila('leased'), fila('retry'), fila('dead'), fila('failed')],
    }, principal);
    expect(out).toMatchObject({ pending: 2, retrying: 1, dead: 2 });
  });
});
