import { useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { AltaRapida } from './AltaRapida';
import type { ConfigChangeOutcome } from './config-change';
import { SpaceWizard } from './SpaceWizard';
import './toggles.css';

/**
 * **UN alta, no dos.**
 *
 * «Espacios y miembros» abría con dos formularios distintos para exactamente la misma alta,
 * desplegados los dos a la vez: «Alta rápida» —un tenant, una room, una membership o una arista— y
 * «Wizard de espacios» —tenant → room → membership → harness—. Medido en Chrome: 460 px de altura
 * combinada antes de llegar a la primera tabla, con un bloque de JSON crudo de once líneas visible
 * por defecto en el medio.
 *
 * Dos formularios abiertos para lo mismo no son el doble de opciones: son una pregunta que el
 * operador tiene que responder antes de poder empezar («¿cuál de los dos es el bueno?»), y la
 * respuesta no está escrita en ningún sitio. Acá se responde: son DOS MODOS del mismo alta, sólo se
 * ve uno, y el rótulo de cada uno dice cuándo conviene.
 *
 * No se retiró ninguno de los dos. El wizard sigue siendo la única forma de encadenar los cuatro
 * pasos con dry-run por paso, y el alta rápida la única de crear una arista ACL sin tipear JSON.
 */

type ModoDeAlta = 'rapida' | 'guiada';

const MODOS: ReadonlyArray<{ id: ModoDeAlta; label: string; descripcion: string }> = [
  {
    id: 'rapida',
    label: 'Un solo recurso',
    descripcion: 'Para dar de alta una cosa: un cliente, una sala, una membresía o una arista de '
      + 'permisos. Un formulario, un envío.',
  },
  {
    id: 'guiada',
    label: 'Espacio completo, paso a paso',
    descripcion: 'Para montar un cliente entero de cero: cliente → sala → membresía → harness, con '
      + 'previsualización antes de cada paso.',
  },
];

export function AltaDeEspacios({ soloLectura, busy, onChange }: {
  soloLectura: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
}) {
  const [modo, setModo] = useState<ModoDeAlta>('rapida');
  const activo = MODOS.find((entrada) => entrada.id === modo) ?? MODOS[0];

  return <section className="alta-unificada">
    {/* Botones de verdad con `role="tab"`, igual que las pestañas de la página: el teclado y el
        lector de pantalla tienen que poder decir cuál de los dos modos está abierto. */}
    <div className="alta-modos" role="tablist" aria-label="Modo de alta">
      {MODOS.map((entrada) => <button
        key={entrada.id}
        type="button"
        role="tab"
        aria-selected={entrada.id === activo.id}
        className="alta-modo"
        onClick={() => setModo(entrada.id)}
      >{entrada.label}</button>)}
    </div>
    <p className="config-area-descripcion">{activo.descripcion}</p>
    <div role="tabpanel" aria-label={activo.label}>
      {activo.id === 'rapida'
        ? <AltaRapida soloLectura={soloLectura} busy={busy} onChange={onChange} />
        : <SpaceWizard canWrite={!soloLectura} busy={busy} onChange={onChange} />}
    </div>
  </section>;
}
