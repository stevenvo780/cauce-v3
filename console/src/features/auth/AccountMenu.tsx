import { ChevronUp, LogOut, UserRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ThemeControl } from '../../components/ThemeControl';
import { Time } from '../../components/ui';
import type { AuthGateState } from './auth-session';
import './auth.css';

export function AccountMenu({ gate, routeKey = '' }: { gate: AuthGateState; routeKey?: string }) {
  const { state, status, busy, error } = gate;
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const name = status === 'in' ? state?.name ?? state?.subject ?? 'Cuenta' : 'Cuenta';

  useEffect(() => { setOpen(false); }, [routeKey]);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        if (container.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return <div className="account-menu" ref={container} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className="account-trigger" ref={trigger}
      aria-label={status === 'in' ? `Cuenta de ${name}` : 'Cuenta y apariencia'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => { setOpen(!open); }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <span className="account-avatar" aria-hidden="true">{status === 'in' && name !== 'Cuenta' ? Array.from(name)[0]?.toLocaleUpperCase() : <UserRound size={18} />}</span>
      <span className="account-name">{name}</span>
      <span className="account-compact-label" aria-hidden="true">Cuenta</span>
      <ChevronUp className="account-chevron" size={16} aria-hidden="true" />
    </button>
    <section hidden={!open} id={id} className="account-popover" role="dialog" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>Cuenta y apariencia</h2>
        <button type="button" className="account-close" aria-label="Cerrar cuenta y apariencia" onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      {status === 'in' && state ? <div className="account-identity">
        <strong>{name}</strong>
        {state.name && state.subject ? <p>{state.subject}</p> : null}
        <p className="account-expiry">{state.expires_at ? <>La sesión vence <Time value={state.expires_at} /></> : 'Vencimiento no informado por el servidor.'}</p>
      </div> : <p className="account-unmanaged">Sin login de verdad: no hay sesión de usuario que cerrar.</p>}
      <div className="account-appearance"><span>Apariencia</span><ThemeControl /></div>
      {error ? <p className="auth-failure" role="alert">{error.message}</p> : null}
      {status === 'in' ? <button className="button secondary account-logout" type="button" disabled={busy} onClick={() => { void gate.logout(); }}>
        <LogOut size={16} aria-hidden="true" />{busy ? 'Cerrando…' : 'Cerrar sesión'}
      </button> : null}
    </section>
  </div>;
}
