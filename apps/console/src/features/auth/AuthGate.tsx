import { KeyRound, LogIn, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApi } from '../../api/context';
import type { ConsoleAuthState } from '../../api/types';
import { timestamp } from '../../lib';
import { useAuthGate, type AuthGateState, type GateStatus } from './auth-session';
import './auth.css';

/**
 * Puerta de sesión de la consola.
 *
 * Hoy en producción el único control de acceso humano es el `basic_auth` de Caddy delante del
 * origen: una contraseña compartida, sin sesión, sin identidad y sin cierre de sesión posible.
 * El gateway, en cambio, YA trae un BFF OIDC completo (`services/gateway/src/oidc-bff.ts`:
 * authorization code + PKCE, sesión cifrada en `gateway_oidc_sessions`, cookies `__Host-`,
 * token CSRF y `/v3/auth/{login,callback,session,logout}`), sólo que arranca con
 * `CAUCE_AUTH_PROVIDER=mtls` y sin proveedor de identidad configurado.
 *
 * Este componente es el lado del navegador de ese login: bloquea la aplicación entera hasta que
 * el SERVIDOR dice que hay sesión. No decide nada por su cuenta y no guarda ningún secreto — la
 * autoridad es la cookie HttpOnly, que este código no puede leer ni falsificar.
 *
 * Los tres desenlaces posibles, y por qué cada uno se comporta así:
 *  - `authenticated: true`  → pasa, y la identidad queda visible arriba con su vencimiento.
 *  - `authenticated: false` → pantalla de login. NO se renderiza nada de la consola detrás.
 *  - `authenticated: null`  → el gateway no expone el BFF (es el caso de HOY). Se deja pasar,
 *    porque bloquear dejaría la consola inservible en producción, pero con un aviso permanente
 *    que dice con todas las letras que no hay login de verdad. Mentir acá sería peor que el
 *    propio agujero: un candado dibujado es más peligroso que una puerta abierta señalizada.
 *
 * Un error de red NO se trata como "sin sesión": se falla cerrado con reintento, porque un
 * gateway caído no es una autorización.
 */

function LoginScreen({ loginUrl, reason }: { loginUrl: string; reason?: string | null }) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-card">
        <span className="auth-mark" aria-hidden="true"><KeyRound size={26} /></span>
        <h1>Consola de Cauce V3</h1>
        <p className="auth-lede">
          Esta consola opera la flota entera: publica mensajes, cancela entregas y abre terminales
          dentro de los contenedores. Requiere una sesión con identidad.
        </p>
        {reason ? <p className="auth-reason">{reason}</p> : null}
        <a className="button auth-primary" href={loginUrl}>
          <LogIn size={17} aria-hidden="true" /> Iniciar sesión
        </a>
        <p className="auth-fineprint">
          El servidor decide. La sesión vive en una cookie <code>__Host-</code> HttpOnly que este
          navegador no puede leer, y toda escritura viaja además con un token CSRF de un solo origen.
        </p>
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

/** Identidad de la sesión para la barra superior. */
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
  if (status !== 'in') return null;
  return (
    <div className="auth-state authenticated">
      <ShieldCheck size={14} aria-hidden="true" />
      <span>
        <strong>{state?.subject ?? 'identidad verificada'}</strong>
        {state?.expires_at ? <small>vence {timestamp(state.expires_at)}</small> : null}
      </span>
      <button className="button small secondary" type="button" disabled={busy} onClick={onLogout}>
        <LogOut size={14} aria-hidden="true" /> {busy ? 'Cerrando…' : 'Cerrar sesión'}
      </button>
    </div>
  );
}

/**
 * Aviso permanente cuando el gateway no tiene login de usuario. Es feo a propósito: tiene que
 * molestar hasta que se configure el proveedor de identidad.
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
  if (gate.status === 'out') return <LoginScreen loginUrl={api.getLoginUrl()} reason={gate.state?.reason} />;
  return <>{children(gate)}</>;
}
