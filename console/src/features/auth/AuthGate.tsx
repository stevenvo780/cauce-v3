import { KeyRound, LogIn, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import type { ConsoleAuthState } from '../../api/types';
import { timestamp } from '../../lib';
import { useAuthGate, type AuthGateState, type GateStatus } from './auth-session';
import './auth.css';

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
 *  - `authenticated: true`  → passes, and the identity stays visible at the top with its expiry.
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
  <p className="auth-fineprint">
    El servidor decide. La sesión vive en una cookie <code>__Host-</code> HttpOnly que este
    navegador no puede leer, y toda escritura viaja además con un token CSRF de un solo origen.
  </p>
);

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
    <main className="auth-screen" id="main-content">
      <section className="auth-card">
        <span className="auth-mark" aria-hidden="true"><KeyRound size={26} /></span>
        <h1>Consola de Cauce V3</h1>
        <p className="auth-lede">{LEDE}</p>
        {reason ? <p className="auth-reason">{reason}</p> : null}
        <form className="auth-form" onSubmit={(event) => { void submit(event); }}>
          <label htmlFor="auth-email">Correo</label>
          <input
            id="auth-email" name="email" type="email" autoComplete="username" required
            value={email} onChange={(event) => { setEmail(event.target.value); }} disabled={busy}
          />
          <label htmlFor="auth-password">Contraseña</label>
          <input
            id="auth-password" name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(event) => { setPassword(event.target.value); }} disabled={busy}
          />
          {failure ? <p className="auth-failure" role="alert">{failure}</p> : null}
          <button className="button auth-primary" type="submit" disabled={busy}>
            <LogIn size={17} aria-hidden="true" /> {busy ? 'Entrando…' : 'Iniciar sesión'}
          </button>
        </form>
        {FINEPRINT}
      </section>
    </main>
  );
}

/** Redirect login: the OIDC BFF. Kept because the gateway may run in that mode. */
function RedirectLoginScreen({ loginUrl, reason }: { loginUrl: string; reason?: string | null }) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card">
        <span className="auth-mark" aria-hidden="true"><KeyRound size={26} /></span>
        <h1>Consola de Cauce V3</h1>
        <p className="auth-lede">{LEDE}</p>
        {reason ? <p className="auth-reason">{reason}</p> : null}
        <a className="button auth-primary" href={loginUrl}>
          <LogIn size={17} aria-hidden="true" /> Iniciar sesión
        </a>
        {FINEPRINT}
      </section>
    </main>
  );
}

function CheckingScreen() {
  return (
    <main className="auth-screen" id="main-content">
      <div className="auth-card auth-card-quiet" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p>Verificando la sesión con el gateway…</p>
      </div>
    </main>
  );
}

function ErrorScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card auth-card-error" role="alert">
        <span className="auth-mark auth-mark-danger" aria-hidden="true"><ShieldAlert size={26} /></span>
        <h1>No se pudo verificar la sesión</h1>
        <p className="auth-lede">{error.message}</p>
        <p className="auth-fineprint">
          Un gateway que no contesta <strong>no es una autorización</strong>: la consola se queda
          cerrada hasta poder comprobar quién sos.
        </p>
        <button type="button" className="button auth-primary" onClick={onRetry}>Reintentar</button>
      </section>
    </main>
  );
}

/** Session identity for the top bar. */
export function SessionBadge({ state, status, busy, onLogout }: {
  state?: ConsoleAuthState;
  status: GateStatus;
  busy: boolean;
  onLogout: () => void;
}) {
  if (status === 'unmanaged') {
    return (
      <span className="auth-state auth-unmanaged" title="El gateway corre con CAUCE_AUTH_PROVIDER=mtls: no hay sesión de usuario que mostrar.">
        <ShieldAlert size={14} aria-hidden="true" /> Sin login de verdad
      </span>
    );
  }
  if (status !== 'in' || !state) return null;
  return (
    <div className="auth-state authenticated">
      <ShieldCheck size={14} aria-hidden="true" />
      <span>
        <strong>{state.name ?? state.subject ?? 'identidad verificada'}</strong>
        {state.name && state.subject ? <small>{state.subject}</small> : null}
        {state.expires_at ? <small>vence {timestamp(state.expires_at)}</small> : null}
      </span>
      <button className="button small secondary" type="button" disabled={busy} onClick={onLogout}>
        <LogOut size={14} aria-hidden="true" /> {busy ? 'Cerrando…' : 'Cerrar sesión'}
      </button>
    </div>
  );
}

/**
 * Permanent notice when the gateway has no user login. It is ugly on purpose: it must be
 * annoying until the identity provider is configured.
 */
export function UnmanagedAuthBanner() {
  return (
    <div className="auth-banner" role="status">
      <ShieldAlert size={16} aria-hidden="true" />
      <p>
        <strong>Esta consola no tiene login de usuario.</strong> El gateway corre con
        <code> CAUCE_AUTH_PROVIDER=mtls</code> y no hay proveedor de identidad configurado: el único
        control es la contraseña compartida de Caddy delante del origen, que no da identidad, ni
        cierre de sesión, ni vencimiento. El BFF OIDC ya está implementado en el gateway y esperando
        configuración — ver <code>ops/console-login/README.md</code>.
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
  return <>{children(gate)}</>;
}
