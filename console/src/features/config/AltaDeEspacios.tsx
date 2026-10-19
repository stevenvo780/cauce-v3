import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { SectionCard } from '../../components/kit';
import { AltaRapida } from './AltaRapida';
import type { ConfigChangeOutcome } from './config-change';
import { SpaceWizard } from './SpaceWizard';

/**
 * Space creation: one resource at a time, or a whole client from scratch.
 */

type ModoDeAlta = 'rapida' | 'guiada';

const MODOS: readonly { id: ModoDeAlta; label: string; nota: string }[] = [
  {
    id: 'rapida',
    label: 'Un solo recurso',
    nota: 'Un espacio, una sala, una membresía o un permiso entre espacios. Un envío.',
  },
  {
    id: 'guiada',
    label: 'Espacio completo, paso a paso',
    nota: 'Un espacio desde cero: espacio, sala y quién entra, con una previsualización en cada paso.',
  },
];

const SEGMENT = 'cursor-pointer rounded-md border-0 bg-transparent px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg data-[pressed]:bg-surface data-[pressed]:text-fg data-[pressed]:shadow-card';

export function AltaDeEspacios({ soloLectura, busy, onChange }: {
  soloLectura: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
}) {
  const [modo, setModo] = useState<ModoDeAlta>('rapida');
  const activo = MODOS.find((entrada) => entrada.id === modo) ?? MODOS[0];

  return <SectionCard level={3} title="Alta de espacios"
    description="Un recurso suelto o el espacio completo. Puedes previsualizar el cambio antes de crearlo.">
    <div className="grid gap-1.5">
      <ToggleGroup aria-label="Modo de alta" value={[activo.id]}
        onValueChange={(valor) => { const siguiente = valor[0] as ModoDeAlta | undefined; if (siguiente) setModo(siguiente); }}
        className="inline-flex w-fit gap-0.5 rounded-lg bg-muted-bg p-0.5">
        {MODOS.map((entrada) => <Toggle key={entrada.id} value={entrada.id} className={SEGMENT}>{entrada.label}</Toggle>)}
      </ToggleGroup>
      <p className="m-0 text-xs text-muted">{activo.nota}</p>
    </div>
    {activo.id === 'rapida'
      ? <AltaRapida soloLectura={soloLectura} busy={busy} onChange={onChange} />
      : <SpaceWizard canWrite={!soloLectura} busy={busy} onChange={onChange} />}
  </SectionCard>;
}
