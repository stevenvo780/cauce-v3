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
 *
 * ---
 *
 * **2026-08-24 — el elegir-modo dejó de ser una segunda fila de pestañas.**
 *
 * MEDIDO en Chrome a 1600×1000: la página dibujaba DOS tiras con `role="tablist"` apiladas, la de
 * las áreas de configuración a y=307 y ésta a y=389, con la misma forma exacta —mismo alto, mismo
 * radio, mismo fondo, mismo 12,5 px de letra—. Dos controles que se dibujan igual dicen que hacen
 * lo mismo, y no lo hacen: el de arriba cambia de ÁREA de la configuración; éste elige un MODO
 * dentro de un solo formulario.
 *
 * Ahora es un control segmentado, y vive DENTRO del panel del alta —se le pasa al hijo como
 * `encabezado`, así que se pinta junto al formulario que gobierna—. Y dejó de ser un `tablist`:
 * un `role="group"` de botones con `aria-pressed` no le promete al teclado una navegación por
 * flechas que este control nunca implementó, y las pestañas de arriba dejan de tener un gemelo
 * falso debajo.
 */

type ModoDeAlta = 'rapida' | 'guiada';

const MODOS: ReadonlyArray<{ id: ModoDeAlta; label: string; nota: string }> = [
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
        onClick={() => setModo(entrada.id)}
      >{entrada.label}</button>)}
    </div>
    <p className="alta-modo-nota">{activo.nota}</p>
  </>;

  return activo.id === 'rapida'
    ? <AltaRapida soloLectura={soloLectura} busy={busy} onChange={onChange} encabezado={encabezado} />
    : <SpaceWizard canWrite={!soloLectura} busy={busy} onChange={onChange} encabezado={encabezado} />;
}
