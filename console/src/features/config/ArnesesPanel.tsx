import { FileText, Slash } from 'lucide-react';
import { Panel } from '../../components/ui';
import {
  ARNESES_REALES, DISTINCION_HERRAMIENTAS_Y_PERMISOS,
  DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
} from './arneses';

/**
 * **What each harness actually reads**, on top of the bot registry.
 *
 * Lives here and not in a document because the question is asked HERE: the operator opens
 * "Agentes y cuentas" (Agents and accounts), sees a "Harness" column with a written value and
 * reasonably concludes the bot's program comes from there, and that changing it changes something.
 * It does not, and nothing changes: the real harness is deduced from the running binary, and that
 * column was wrong for 5 of the 14 aliases.
 *
 * What this panel does is answer the next question, which is the useful one: if it is not that
 * column, where does one touch what the bot reads? The answer is different for each of the four
 * harnesses, and for none of the four is it this screen — not even for the declared role, which
 * Cauce prepends on its own, which is why it works even with the harness that reads no file.
 */
export function ArnesesPanel() {
  return (
    <Panel
      title="Qué lee cada arnés de verdad"
      subtitle="Contexto declarado, capacidades del runtime y permisos no son lo mismo"
    >
      <p className="notice arnes-gobierna" role="note">{DISTINCION_HERRAMIENTAS_Y_PERMISOS}</p>
      <ul className="arnes-lista">
        {ARNESES_REALES.map((arnes) => (
          <li key={arnes.id} className="arnes-card" data-sin-directiva={arnes.directiva === '' ? 'true' : undefined}>
            <header>
              <h3>{arnes.label}</h3>
              <code className="arnes-id">{arnes.id}</code>
            </header>
            {/* The path is the piece of data the visitor came for, so it goes first and in
                monospace. When none is set, it is SAID in letters: an empty row reads as "we
                don't know", which is the opposite of what happens with hermes. */}
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
      {/* The close: where the declared role is written, which here also is not. A panel that only
          says "not here" sends the operator to another screen without saying which one. */}
      <p className="notice arnes-gobierna" role="note">{DONDE_SE_ESCRIBE_EL_ROL_DECLARADO}</p>
    </Panel>
  );
}
