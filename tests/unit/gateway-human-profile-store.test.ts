import type { DatabasePool } from '@cauce/store';
import { expect, it, vi } from 'vitest';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';

it('updates only display_name and updated_at for the active authenticated row with bound parameters', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ display_name: 'Nombre confirmado' }] });
  const store = new PostgresConsoleUserStore({ query } as unknown as DatabasePool);
  const id = '11111111-1111-4111-8111-111111111111';
  expect(await store.updateDisplayName(id, 'Nombre confirmado')).toBe('Nombre confirmado');
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'UPDATE console_users SET display_name=$2, updated_at=now() WHERE id=$1::uuid AND active=true RETURNING display_name',
    [id, 'Nombre confirmado'],
  );
  query.mockResolvedValue({ rows: [] });
  expect(await store.updateDisplayName(id, 'Otro')).toBeUndefined();
  query.mockClear();
  expect(await store.updateDisplayName('invalid', 'Otro')).toBeUndefined();
  expect(query).not.toHaveBeenCalled();
});
