import { FileText, Slash } from 'lucide-react';
import { Panel } from '../../components/ui';
import { ARNESES_REALES, LO_QUE_AJUSTES_GOBIERNA } from './arneses';

/**
 * **Qué lee cada arnés de verdad**, encima del registro de bots.
 *
 * Va acá y no en un documento porque la pregunta se hace ACÁ: el operador entra a «Agentes y
 * cuentas», ve una columna «Harness» con un valor escrito y deduce —razonablemente— que de ahí sale
 * el programa que corre el bot y que cambiándola cambia algo. No sale, y no cambia nada: el arnés
 * real se deduce del binario en ejecución, y esa columna se equivocaba en 5 de los 14 alias el
 * 23-ago-2026.
 *
 * Lo que este panel hace es contestar la pregunta siguiente, que es la útil: si no es esa columna,
 * ¿dónde se toca lo que el bot lee? La respuesta es distinta en los cuatro arneses y en ninguno de
 * los cuatro es esta pantalla — salvo el rol declarado, que es lo único que Cauce antepone él mismo
 * y por eso funciona hasta con el arnés que no lee ningún fichero.
 */
export function ArnesesPanel() {
  return (
    <Panel
      title="Qué lee cada arnés de verdad"
      subtitle="Y por qué la columna «Harness» de la tabla de abajo no lo decide"
    >
      <ul className="arnes-lista">
        {ARNESES_REALES.map((arnes) => (
          <li key={arnes.id} className="arnes-card" data-sin-directiva={arnes.directiva === '' ? 'true' : undefined}>
            <header>
              <h3>{arnes.label}</h3>
              <code className="arnes-id">{arnes.id}</code>
            </header>
            {/* La ruta es el dato que se viene a buscar, así que va primero y en monoespaciada.
                Cuando no hay ninguna se DICE con letras: una fila en blanco se lee como «no lo
                sabemos», que es lo contrario de lo que pasa con hermes. */}
            {arnes.directiva === '' ? (
              <p className="arnes-ruta arnes-ruta-vacia">
                <Slash size={14} aria-hidden="true" />
                No lee ningún documento de instrucciones.
              </p>
            ) : (
              <p className="arnes-ruta">
                <FileText size={14} aria-hidden="true" />
                <code>{arnes.directiva}</code>
              </p>
            )}
            <p className="arnes-detalle">{arnes.detalle}</p>
            <p className="arnes-donde">
              <strong>Dónde se toca:</strong> {arnes.dondeSeToca}
            </p>
          </li>
        ))}
      </ul>
      {/* El cierre: qué SÍ gobierna esta pantalla. Un panel que sólo dice «acá no» manda al
          operador a otra pantalla sin decirle qué se lleva de ésta. */}
      <p className="notice arnes-gobierna" role="note">{LO_QUE_AJUSTES_GOBIERNA}</p>
    </Panel>
  );
}
