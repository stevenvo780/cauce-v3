import { describe, expect, it } from 'vitest';
import { isDelegatedSubAgentTurn } from '../src/repository/agents/fanin/helpers.js';
import type { DeliveryRow } from '../src/repository/observability.js';

// Los alias son únicos sólo dentro de un tenant: un homónimo en otro tenant que recibe una rama de
// la cadena sigue siendo un turno delegado, y su progreso no puede ir al chat del root.
const row = (recipientTenant: string, recipientAlias: string): DeliveryRow => ({
  recipient_tenant: recipientTenant,
  recipient_alias: recipientAlias,
  origin: {
    adapter: 'telegram', channel: 'telegram', conversation_id: 'chat', relay: [],
    metadata: { bridge_alias: 'salva', bridge_tenant: 'Isa' }
  }
}) as unknown as DeliveryRow;

describe('isDelegatedSubAgentTurn', () => {
  it('trata al homónimo de otro tenant como turno delegado', () => {
    expect(isDelegatedSubAgentTurn(row('Miguel', 'salva'))).toBe(true);
  });

  it('el alias al que habló la persona, en su tenant, no es delegado', () => {
    expect(isDelegatedSubAgentTurn(row('Isa', 'salva'))).toBe(false);
  });

  it('otro alias del mismo tenant sigue siendo delegado', () => {
    expect(isDelegatedSubAgentTurn(row('Isa', 'otro'))).toBe(true);
  });
});
