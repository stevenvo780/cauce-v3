import { LogIn, ShieldAlert } from 'lucide-react';
import { Fragment, useState, type SyntheticEvent, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { cn } from '../../cn';
import { Logo } from '../../components/brand/Logo';
import { Button, LinkButton, Notice } from '../../components/form-kit';
import { useAuthGate, type AuthGateState } from './auth-session';
import { authSessionKey } from './account-identity';

/**
 * Console session gate.
 *
 * Locks the entire application until the SERVER says there is a session. It decides nothing on
 * its own and stores no secret: the authority is the HttpOnly cookie, which this code cannot
 * read or forge. Neither the password nor the token end up in `localStorage` — an XSS here
 * does not steal the session because there is nothing to steal.
 *
 * The gateway says HOW to enter, in `login_mode`:
 *  - `password` → email and password form against `POST /v3/auth/login`
 *    (`services/gateway/src/password-auth.ts`, accounts in the `console_users` table).
 *  - `redirect` or absent → the OIDC BFF from `services/gateway/src/oidc-bff.ts`, activated
 *    by navigating to `/v3/auth/login`.
 *
 * The three possible outcomes, and why each behaves that way:
 *  - `authenticated: true`  → passes, and the identity and expiry are available in the account popover.
 *  - `authenticated: false` → login screen. Nothing behind the console is rendered.
 *  - `authenticated: null`  → the gateway exposes no BFF (`CAUCE_AUTH_PROVIDER=mtls`, which is
 *    what is deployed until login is enabled). It lets through, because blocking would render
 *    the console unusable in production, but with a permanent notice that spells out that there
 *    is no real login. Lying here would be worse than the hole itself: a drawn padlock is more
 *    dangerous than a marked-open door.
 *
 * A network error is NOT treated as "no session": it fails closed with retry, because a downed
 * gateway is not an authorization.
 */

const LEDE = 'Esta consola opera la flota entera: publica mensajes, cancela entregas y abre '
  + 'terminales dentro de los contenedores. Requiere una sesión con identidad.';

const FINEPRINT = (
  <p className="m-0 text-xs text-muted">
    El servidor decide. La sesión vive en una cookie <code className="font-mono">__Host-</code> HttpOnly que este
    navegador no puede leer, y toda escritura viaja además con un token CSRF de un solo origen.
  </p>
);

/** Centered card on the bare canvas: nothing of the console renders behind it. */
function AuthScreen({ tone, role, children }: { tone?: 'danger'; role?: 'alert' | 'status'; children: ReactNode }) {
  return (
    <main id="main-content" className="grid min-h-dvh place-items-center bg-canvas p-4 text-fg">
      <section
        role={role}
        className={cn(
          'grid w-full max-w-sm gap-4 rounded-2xl border bg-surface p-6 shadow-pop [&_h1]:m-0 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight',
          tone === 'danger' ? 'border-danger/40' : 'border-line',
        )}
      >
        {children}
      </section>
    </main>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[13px] leading-relaxed text-fg-2">{children}</p>;
}

/** Password form. Credential errors are shown here, not in the failure screen. */
function PasswordLoginForm({ login, busy, reason }: {
  login: (email: string, password: string) => Promise<void>;
  busy: boolean;
  reason?: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string>();

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(undefined);
    try {
      await login(email, password);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'No se pudo iniciar sesión.');
    } finally {
      // The password does not survive the attempt, not even in the component's memory.
      setPassword('');
    }
  };

  return (
    <AuthScreen>
      <Logo />
      <h1>Consola de Cauce V3</h1>
      <Lede>{LEDE}</Lede>
      {reason ? <Notice tone="warn">{reason}</Notice> : null}
      <form className="grid gap-3" onSubmit={(event) => { void submit(event); }}>
        <label htmlFor="auth-email">
          Correo
          <input
            id="auth-email" name="email" type="email" autoComplete="username" required
            value={email} onChange={(event) => { setEmail(event.target.value); }} disabled={busy}
          />
        </label>
        <label htmlFor="auth-password">
          Contraseña
          <input
            id="auth-password" name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(event) => { setPassword(event.target.value); }} disabled={busy}
          />
        </label>
        {failure ? <Notice tone="danger" role="alert">{failure}</Notice> : null}
        <Button type="submit" variant="primary" className="mt-1 min-h-10" disabled={busy}>
          <LogIn size={16} aria-hidden="true" /> {busy ? 'Entrando…' : 'Iniciar sesión'}
        </Button>
      </form>
      {FINEPRINT}
    </AuthScreen>
  );
}

/** Redirect login: the OIDC BFF. Kept because the gateway may run in that mode. */
function RedirectLoginScreen({ loginUrl, reason }: { loginUrl: string; reason?: string | null }) {
  return (
    <AuthScreen>
      <Logo />
      <h1>Consola de Cauce V3</h1>
      <Lede>{LEDE}</Lede>
      {reason ? <Notice tone="warn">{reason}</Notice> : null}
      <LinkButton variant="primary" className="min-h-10" href={loginUrl}>
        <LogIn size={16} aria-hidden="true" /> Iniciar sesión
      </LinkButton>
      {FINEPRINT}
    </AuthScreen>
  );
}

function CheckingScreen() {
  return (
    <AuthScreen role="status">
      <div className="flex items-center gap-3 text-[13px] text-fg-2" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p className="m-0">Verificando la sesión con el gateway…</p>
      </div>
    </AuthScreen>
  );
}

function ErrorScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <AuthScreen tone="danger" role="alert">
      <span className="grid size-10 place-items-center rounded-full bg-danger-soft text-danger-ink" aria-hidden="true"><ShieldAlert size={20} /></span>
      <h1>No se pudo verificar la sesión</h1>
      <Lede>{error.message}</Lede>
      <p className="m-0 text-xs text-muted">
        Un gateway que no contesta <strong className="text-fg">no es una autorización</strong>: la consola se queda
        cerrada hasta poder comprobar quién sos.
      </p>
      <Button variant="primary" className="min-h-10" onClick={onRetry}>Reintentar</Button>
    </AuthScreen>
  );
}

/**
 * Permanent notice when the gateway has no user login. It is ugly on purpose: it must be
 * annoying until the identity provider is configured.
 */
export function UnmanagedAuthBanner() {
  return (
    <div className="flex items-start gap-2.5 border-b border-warn/40 bg-warn-soft px-4 py-2 text-warn-ink" role="status">
      <ShieldAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="m-0 text-xs leading-snug">
        <strong>Esta consola no tiene login de usuario.</strong> El gateway corre con
        <code className="font-mono"> CAUCE_AUTH_PROVIDER=mtls</code>: el único control es la contraseña compartida
        de Caddy, sin identidad, cierre de sesión ni vencimiento. Ver <code className="font-mono">ops/console-login/README.md</code>.
      </p>
    </div>
  );
}

export function AuthGate({ children }: { children: (gate: AuthGateState) => ReactNode }) {
  const gate = useAuthGate();
  const api = useApi();

  if (gate.status === 'checking') return <CheckingScreen />;
  if (gate.status === 'error' && gate.error) return <ErrorScreen error={gate.error} onRetry={() => void gate.check()} />;
  if (gate.status === 'out') {
    // Without `login_mode` redirect is assumed: that is how the console behaved before password
    // login existed, and an old gateway has to keep coming in through its own path.
    return gate.state?.login_mode === 'password'
      ? <PasswordLoginForm login={gate.login} busy={gate.busy} reason={gate.state.reason} />
      : <RedirectLoginScreen loginUrl={api.getLoginUrl()} reason={gate.state?.reason} />;
  }
  return <Fragment key={authSessionKey(gate.state)}>{children(gate)}</Fragment>;
}
