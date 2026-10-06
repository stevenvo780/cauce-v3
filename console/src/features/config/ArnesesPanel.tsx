import { FileText, Slash } from 'lucide-react';
import { Notice, SectionCard } from '../../components/kit';
import {
  ARNESES_REALES, DISTINCION_HERRAMIENTAS_Y_PERMISOS,
  DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
} from './arneses';

/**
 * **What each harness actually reads**, on top of the harness definitions.
 *
 * Lives here and not in a document because the question is asked HERE: the operator sees a
 * "Harness" column with a written value and reasonably concludes the agent's program comes from
 * there. It does not: the real harness is deduced from the running binary. What this answers is
 * the useful next question: where does one touch what the agent reads? The answer differs for
 * each harness, and for none of them is it this screen.
 */
export function ArnesesPanel() {
  return (
    <SectionCard
      level={3}
      title="Qué lee cada arnés de verdad"
      description="Contexto declarado, capacidades del runtime y permisos no son lo mismo"
    >
      <Notice role="note">{DISTINCION_HERRAMIENTAS_Y_PERMISOS}</Notice>
      <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
        {ARNESES_REALES.map((arnes) => (
          <li key={arnes.id} className="grid content-start gap-2 rounded-lg border border-line p-3"
            data-sin-directiva={arnes.directiva === '' ? 'true' : undefined}>
            <header className="flex items-baseline justify-between gap-2">
              <h4 className="m-0 text-sm font-semibold">{arnes.label}</h4>
              <code className="text-xs text-muted">{arnes.id}</code>
            </header>
            {/* The path is the piece of data the visitor came for, so it goes first and in monospace. When
                none is set, it is SAID in letters: an empty row reads as "we don't know", which is the
                opposite of what happens with an agent that reads no file. */}
            {arnes.directiva === '' ? (
              <p className="m-0 flex items-center gap-1.5 text-xs text-muted">
                <Slash size={14} aria-hidden="true" />
                No lee ningún documento de instrucciones.
              </p>
            ) : (
              <p className="m-0 flex items-center gap-1.5 text-xs">
                <FileText size={14} aria-hidden="true" className="text-muted" />
                <code className="break-all">{arnes.directiva}</code>
              </p>
            )}
            <p className="m-0 text-[13px] text-fg-2">{arnes.detalle}</p>
            <p className="m-0 text-[13px]">
              <strong>Dónde se toca:</strong> {arnes.dondeSeToca}
            </p>
          </li>
        ))}
      </ul>
      {/* The close: where the declared role is written, which here also is not. A panel that only says
          "not here" sends the operator to another screen without saying which one. */}
      <Notice role="note">{DONDE_SE_ESCRIBE_EL_ROL_DECLARADO}</Notice>
    </SectionCard>
  );
}
