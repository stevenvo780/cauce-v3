import { ChevronUp, LogOut, UserRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { HumanProfileEditor } from './HumanProfileEditor';
import { humanProfileName } from './account-identity';
import { ThemeControl } from '../../components/ThemeControl';
import { Time } from '../../components/ui';
import type { AuthGateState } from './auth-session';
import './auth.css';

export function AccountMenu({ gate, routeKey = '' }: { gate: AuthGateState; routeKey?: string }) {
  return <ConsoleAccessBoundary><AccountPopover gate={gate} routeKey={routeKey} /></ConsoleAccessBoundary>;
}

function AccountPopover({ gate, routeKey }: { gate: AuthGateState; routeKey: string }) {
  const { state, status, busy, error } = gate;
  const access = useConsoleAccess();
  const technicalIdentity = access.data?.subject?.trim();
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const switchHeading = useRef<HTMLParagraphElement>(null);
  const name = status === 'in' ? humanProfileName(state) : 'Cuenta';

  useEffect(() => { setOpen(false); setConfirmSwitch(false); }, [routeKey, state?.subject]);
  useEffect(() => { if (!open) setConfirmSwitch(false); }, [open]);
  useEffect(() => { if (confirmSwitch) switchHeading.current?.focus({ preventScroll: true }); }, [confirmSwitch]);

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
      data-navigation-label="Cuenta"
      aria-label={status === 'in' ? `Cuenta de ${name}` : 'Cuenta y apariencia'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => { setOpen(!open); }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <span className="account-avatar" aria-hidden="true">{status === 'in' && name !== 'Cuenta' ? Array.from(name)[0]?.toLocaleUpperCase() : <UserRound size={18} />}</span>
      <span className="account-name">{name}</span>
      <ChevronUp className="account-chevron" size={16} aria-hidden="true" />
    </button>
    <section hidden={!open} id={id} className="account-popover" role="dialog" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>Cuenta y apariencia</h2>
        <button type="button" className="account-close" aria-label="Cerrar cuenta y apariencia" onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      {status === 'in' && state ? <div className="account-identity">
        <p className="account-section-label">Perfil humano actual</p>
        <strong>{name}</strong>
        {open && state.login_mode === 'password' ? <HumanProfileEditor
          key={`${routeKey}:${state.subject ?? ''}:${state.csrf_token ?? ''}`} name={name} disabled={busy} /> : null}
        {state.subject ? <p><span>Cuenta: </span><span>{state.subject}</span></p> : null}
        <p>Este es tu perfil de sesión. La autoría de cada mensaje conserva su propia evidencia.</p>
        <p className="account-expiry">{state.expires_at ? <>La sesión vence <Time value={state.expires_at} /></> : 'Vencimiento no informado por el servidor.'}</p>
      </div> : <p className="account-unmanaged">Sin login de verdad: no hay sesión de usuario que cerrar.</p>}
      {status === 'in' ? <div className="account-identity account-technical">
        <p className="account-section-label">Identidad técnica</p>
        {access.error ? <><p role="status">No se pudo verificar la identidad técnica.</p><button
          type="button" className="button secondary" disabled={access.loading}
          onClick={() => { void access.reload(); }}>Reintentar identidad</button></>
          : access.loading ? <p role="status">Verificando identidad técnica…</p>
          : <><code>{technicalIdentity === undefined || technicalIdentity.length === 0 ? 'No informada por el servidor' : technicalIdentity}</code>
            <p>El servidor usa esta identidad para enrutar y comprobar permisos. No es el nombre de la persona.</p></>}
      </div> : null}
      <div className="account-appearance"><span>Apariencia</span><ThemeControl /></div>
      {error ? <p className="auth-failure" role="alert">{error.message}</p> : null}
      {status === 'in' ? <button ref={switchTrigger} type="button" className="button secondary account-logout" disabled={busy} aria-expanded={confirmSwitch} onClick={() => { setConfirmSwitch(!confirmSwitch); }}>Cambiar cuenta</button> : null}
      {status === 'in' && confirmSwitch ? <div className="account-switch">
        <p ref={switchHeading} tabIndex={-1}>Se cerrará esta sesión y se descartarán los borradores locales. Después podés entrar con otra cuenta existente.</p>
        {state?.login_mode !== 'password' ? <p>El proveedor de acceso puede volver a usar la misma cuenta; elegí otra allí si ocurre.</p> : null}
        <button type="button" className="button secondary" disabled={busy} onClick={() => { setConfirmSwitch(false); switchTrigger.current?.focus({ preventScroll: true }); }}>Cancelar cambio</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => { void gate.logout(); }}>{busy ? 'Cerrando…' : 'Cerrar sesión y continuar'}</button>
      </div> : null}
      {status === 'in' && !confirmSwitch ? <button className="button secondary account-logout" type="button" disabled={busy} onClick={() => { void gate.logout(); }}>
        <LogOut size={16} aria-hidden="true" />{busy ? 'Cerrando…' : 'Cerrar sesión'}
      </button> : null}
    </section>
  </div>;
}
