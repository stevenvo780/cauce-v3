import type { TestSequencerConstructor } from 'vitest/node';

export function opcionesDeTrozo(
  opciones?: { repartirTrabajadores?: boolean },
  entorno?: Record<string, string | undefined>,
): { sequence?: { sequencer: TestSequencerConstructor }; maxWorkers?: number };
