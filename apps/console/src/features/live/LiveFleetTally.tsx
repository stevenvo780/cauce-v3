import type { Dispatch, SetStateAction } from 'react';
import { Tooltip } from '../../components/ui';
import { LIVE_STATE_META, STATE_ACCENT, type LiveState } from './agent-state';
import type { Deriva } from './deriva';

/**
 * Orden de la cinta de triage: de lo que exige acción a lo que no.
 */
const TALLY_ORDER: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'settled', 'idle',
];

export interface LiveFleetTallyProps {
  tally: Record<LiveState, number>;
  stateFilter: LiveState | undefined;
  setStateFilter: Dispatch<SetStateAction<LiveState | undefined>>;
  deriva: Deriva;
}

export function LiveFleetTally({
  tally,
  stateFilter,
  setStateFilter,
  deriva,
}: LiveFleetTallyProps) {
  return (
    <div className="live-tally">
      {TALLY_ORDER.map((state) => {
        const meta = LIVE_STATE_META[state];
        return (
          <Tooltip key={state} label={meta.hint} focusable={false}>
            <button
              type="button"
              className="live-tally-chip"
              style={{ ['--accent' as string]: STATE_ACCENT[state] }}
              data-empty={tally[state] === 0 ? 'true' : undefined}
              aria-pressed={stateFilter === state}
              onClick={() => setStateFilter((current) => (current === state ? undefined : state))}
              title={meta.hint}
            >
              <span className="live-tally-swatch" aria-hidden="true" />
              {meta.label} <strong>{tally[state]}</strong>
            </button>
          </Tooltip>
        );
      })}
      {deriva.sinRegistro > 0 ? (
        <Tooltip
          focusable={false}
          label="Alias con membresía habilitada en una sala que NO tienen fila en el registro de agentes. No son una avería por sí solos: los principales de operador (por ejemplo el recolector de cuotas) viven así a propósito. Si este número sube tras un alta o una baja, es que se tocó una sola de las dos tablas."
        >
          <span className="live-tally-chip is-unreported" data-testid="deriva-sin-registro">
            <span className="live-tally-swatch" aria-hidden="true" />
            Fuera del registro <strong>{deriva.sinRegistro}</strong>
          </span>
        </Tooltip>
      ) : null}
      {deriva.sinSala > 0 ? (
        <Tooltip
          focusable={false}
          label="Alias que SÍ están en el registro de agentes y no tienen ni una membresía habilitada. Se dibujan igual, en el recuadro «sin sala» —esconderlos fue el fallo que dejó a `gaia` invisible el día de su alta— pero nadie los contaba: alta en el registro sin sala es media alta."
        >
          <span className="live-tally-chip is-unreported" data-testid="deriva-sin-sala">
            <span className="live-tally-swatch" aria-hidden="true" />
            Sin sala <strong>{deriva.sinSala}</strong>
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}
