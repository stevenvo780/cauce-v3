import { HelpCircle, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Tooltip } from './Tooltip';

/**
 * What a view is for, and the permissions it demands, out of the way until they are asked for.
 *
 * Every page opened with a paragraph of prose plus its RBAC lines, so the first screenful of every
 * view was reference text and the work began below it. The words are unchanged; what changes is the
 * price: one button in the row the title already occupies, instead of a block above the content.
 */
function PageHelpDialog({ title, description, devolverFocoA, onCerrar, children }: {
  title: string;
  description: string;
  devolverFocoA: RefObject<HTMLButtonElement | null>;
  onCerrar: () => void;
  children?: ReactNode;
}) {
  const dialogo = useRef<HTMLDivElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);
  const foco = useRef(devolverFocoA);
  foco.current = devolverFocoA;

  useEffect(() => {
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    cerrar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      foco.current.current?.focus();
    };
  }, []);

  const atraparFoco = useFocusTrap(dialogo);
  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key === 'Escape') { evento.stopPropagation(); onCerrar(); return; }
    atraparFoco(evento);
  };

  return createPortal(
    <div
      className="page-help-fondo"
      onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onCerrar(); }}
    >
      <div
        className="page-help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-help-titulo"
        ref={dialogo}
        onKeyDown={teclado}
      >
        <header className="page-help-head">
          <h2 id="page-help-titulo">{title}</h2>
          <button type="button" className="button small secondary" ref={cerrar} onClick={onCerrar}>
            <X size={14} aria-hidden="true" /> Cerrar
          </button>
        </header>
        <p className="page-help-descripcion">{description}</p>
        {children ? <div className="page-help-extra">{children}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function PageHelp({ title, description, children }: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const abridor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Tooltip label={`Qué es «${title}» y qué exige`} focusable={false}>
        <button
          type="button"
          className="page-help-boton"
          ref={abridor}
          aria-haspopup="dialog"
          aria-expanded={abierto}
          aria-label={`Qué es «${title}»`}
          onClick={() => { setAbierto(true); }}
        >
          <HelpCircle size={18} aria-hidden="true" />
        </button>
      </Tooltip>
      {abierto ? (
        <PageHelpDialog
          title={title}
          description={description}
          devolverFocoA={abridor}
          onCerrar={() => { setAbierto(false); }}
        >
          {children}
        </PageHelpDialog>
      ) : null}
    </>
  );
}
