import { Popover } from '@base-ui/react/popover';
import { ChevronUp, LogOut, ShieldAlert, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { cn } from '../../cn';
import { ActionButton } from '../../components/action-button';
import { Button, Notice } from '../../components/kit';
import { ThemeControl } from '../../components/ThemeControl';
import { Time } from '../../components/ui';
import { humanProfileName } from './account-identity';
import type { AuthGateState } from './auth-session';
import { ClientConnectionsPanel } from './ClientConnectionsPanel';
import { HumanProfileEditor } from './HumanProfileEditor';
import { CompanySelector } from './CompanySelector';

function Avatar({ name, known, size }: { name: string; known: boolean; size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand-ink"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {known ? Array.from(name)[0]?.toLocaleUpperCase() : <UserRound size={size * 0.55} />}
    </span>
  );
}

const SECTION = 'grid gap-1.5 border-t border-line pt-3 [&_p]:m-0 [&_p]:break-words';
const LABEL = 'text-xs font-medium text-muted';

export function AccountMenu({ gate, routeKey = '' }: { gate: AuthGateState; routeKey?: string }) {
  return <ConsoleAccessBoundary><AccountPopover gate={gate} routeKey={routeKey} /></ConsoleAccessBoundary>;
}

function AccountPopover({ gate, routeKey }: { gate: AuthGateState; routeKey: string }) {
  const { state, status, busy, error } = gate;
  const access = useConsoleAccess();
  const technicalIdentity = access.data?.subject?.trim();
  const [open, setOpen] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const switchHeading = useRef<HTMLParagraphElement>(null);
  const signedIn = status === 'in';
  const name = signedIn ? humanProfileName(state) : 'Cuenta';

  useEffect(() => { setOpen(false); setConfirmSwitch(false); }, [routeKey, state?.subject]);
  useEffect(() => { if (!open) setConfirmSwitch(false); }, [open]);
  useEffect(() => { if (confirmSwitch) switchHeading.current?.focus({ preventScroll: true }); }, [confirmSwitch]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* `.account-name` and `.account-chevron` are the hooks the shell hides on the icon rail. */}
      <Popover.Trigger
        data-navigation-label="Cuenta"
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}
        aria-label={signedIn ? `Cuenta de ${name}` : 'Cuenta y apariencia'}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent p-1.5 text-left text-fg transition-colors hover:bg-subtle data-[popup-open]:bg-muted-bg in-data-[sidebar=rail]:justify-center"
      >
        <Avatar name={name} known={signedIn && name !== 'Cuenta'} size={32} />
        <span className="account-name min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        <ChevronUp className="account-chevron shrink-0 text-muted" size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} className="z-[60]">
          <Popover.Popup
            initialFocus={heading}
            className="flex max-h-[min(var(--available-height),calc(100dvh-4.5rem))] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden overscroll-contain rounded-xl border border-line bg-surface text-[13px] text-fg shadow-pop outline-none"
          >
            <header className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4">
              <Popover.Title ref={heading} tabIndex={-1} className="m-0 text-sm font-semibold outline-none">Cuenta y apariencia</Popover.Title>
              <Popover.Close aria-label="Cerrar cuenta y apariencia" className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
                <X size={16} aria-hidden="true" />
              </Popover.Close>
            </header>
            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 py-3">

            {signedIn && state ? (
              <div className="grid gap-2 [&_p]:m-0 [&_p]:break-words">
                <p className={LABEL}>Perfil humano actual</p>
                <div className="flex items-center gap-3">
                  <Avatar name={name} known={name !== 'Cuenta'} size={40} />
                  <div className="grid min-w-0">
                    <strong className="break-words text-sm">{name}</strong>
                    {state.subject ? <span className="break-all text-xs text-muted">{state.subject}</span> : null}
                  </div>
                </div>
                {open && state.login_mode === 'password' ? (
                  <HumanProfileEditor key={`${routeKey}:${state.subject ?? ''}:${state.csrf_token ?? ''}`} name={name} disabled={busy} />
                ) : null}
                <p className="text-xs text-muted">Este es tu perfil de sesión. La autoría de cada mensaje conserva su propia evidencia.</p>
                <p className="text-xs text-muted">
                  {state.expires_at ? <>La sesión vence <Time value={state.expires_at} /></> : 'Vencimiento no informado por el servidor.'}
                </p>
              </div>
            ) : (
              <Notice tone="warn" className="flex items-center gap-2">
                <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
                <p>Sin login de verdad: no hay sesión de usuario que cerrar.</p>
              </Notice>
            )}

            {signedIn ? (
              <div className={SECTION}>
                <p className={LABEL}>Identidad técnica</p>
                {access.error ? (
                  <>
                    <p role="status">No se pudo verificar la identidad técnica.</p>
                    <ActionButton size="sm" className="justify-self-start" label="Reintentar identidad" pendingLabel="Reintentando…" busy={access.loading} announceError={false} action={() => access.reload()} />
                  </>
                ) : access.loading ? <p role="status">Verificando identidad técnica…</p> : (
                  <>
                    <code className="w-fit max-w-full rounded-md bg-subtle px-1.5 py-0.5 font-mono text-xs break-all">
                      {technicalIdentity === undefined || technicalIdentity.length === 0 ? 'No informada por el servidor' : technicalIdentity}
                    </code>
                    <p className="text-xs text-muted">El servidor usa esta identidad para enrutar y comprobar permisos. No es el nombre de la persona.</p>
                  </>
                )}
              </div>
            ) : null}

            {signedIn && open && state?.authority ? <CompanySelector /> : null}

            {signedIn && state?.login_mode === 'password' ? (
              <ClientConnectionsPanel key={`${state.subject ?? ''}:${state.csrf_token ?? ''}`} active={open} disabled={busy} />
            ) : null}

            <div className={SECTION}>
              <span className={LABEL}>Apariencia</span>
              <ThemeControl />
            </div>

            {error ? <Notice tone="danger" role="alert">{error.message}</Notice> : null}
            </div>

            {signedIn ? (
              <div className={cn(SECTION, 'shrink-0 gap-2 bg-surface px-4 pt-3 pb-4')}>
                <Button ref={switchTrigger} className="justify-start" disabled={busy} aria-expanded={confirmSwitch} onClick={() => { setConfirmSwitch(!confirmSwitch); }}>
                  Cambiar cuenta
                </Button>
                {confirmSwitch ? (
                  <div className="grid gap-2 rounded-lg bg-subtle p-3 [&_p]:m-0 [&_p]:text-xs [&_p]:text-fg-2">
                    <p ref={switchHeading} tabIndex={-1} className="outline-none">Se cerrará esta sesión y se descartarán los borradores locales. Después podés entrar con otra cuenta existente.</p>
                    {state?.login_mode !== 'password' ? <p>El proveedor de acceso puede volver a usar la misma cuenta; elegí otra allí si ocurre.</p> : null}
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={() => { setConfirmSwitch(false); switchTrigger.current?.focus({ preventScroll: true }); }}>Cancelar cambio</Button>
                      <Button variant="danger" disabled={busy} onClick={() => { void gate.logout(); }}>{busy ? 'Cerrando…' : 'Cerrar sesión y continuar'}</Button>
                    </div>
                  </div>
                ) : (
                  <Button className="justify-start" disabled={busy} onClick={() => { void gate.logout(); }}>
                    <LogOut size={15} aria-hidden="true" />{busy ? 'Cerrando…' : 'Cerrar sesión'}
                  </Button>
                )}
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
