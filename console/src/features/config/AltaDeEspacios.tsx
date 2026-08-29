import { useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { AltaRapida } from './AltaRapida';
import type { ConfigChangeOutcome } from './config-change';
import { SpaceWizard } from './SpaceWizard';
import './toggles.css';

/**
 * Unified form for space creation (quick or guided).
 */

type ModoDeAlta = 'rapida' | 'guiada';

const MODOS: readonly { id: ModoDeAlta; label: string; nota: string }[] = [
  {
    id: 'rapida',
    label: 'Un solo recurso',
    nota: 'Un cliente, una sala, una membresía o una arista de permisos. Un envío.',
  },
  {
    id: 'guiada',
    label: 'Espacio completo, paso a paso',
    nota: 'Un cliente de cero: cliente → sala → membresía → harness, con dry-run por paso.',
  },
];

export function AltaDeEspacios({ soloLectura, busy, onChange }: {
  soloLectura: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
}) {
  const [modo, setModo] = useState<ModoDeAlta>('rapida');
  const activo = MODOS.find((entrada) => entrada.id === modo) ?? MODOS[0];

  const encabezado = <>
    <div className="alta-segmento" role="group" aria-label="Modo de alta">
      {MODOS.map((entrada) => <button
        key={entrada.id}
        type="button"
        aria-pressed={entrada.id === activo.id}
        className="alta-segmento-boton"
        onClick={() => { setModo(entrada.id); }}
      >{entrada.label}</button>)}
    </div>
    <p className="alta-modo-nota">{activo.nota}</p>
  </>;

  return activo.id === 'rapida'
    ? <AltaRapida soloLectura={soloLectura} busy={busy} onChange={onChange} encabezado={encabezado} />
    : <SpaceWizard canWrite={!soloLectura} busy={busy} onChange={onChange} encabezado={encabezado} />;
}
