import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** What is inside, said as the operator would name it: it becomes the panel's heading. */
  label: string;
  children: ReactNode;
  onReset?: () => void;
  /** Any change clears a stuck boundary, so a route change does not leave a dead view. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error?: Error;
  route?: string;
  /** Bumped on every clear so the children mount fresh instead of re-rendering the broken ones. */
  attempt: number;
}

/**
 * A recoverable panel in place of a subtree that threw while rendering.
 *
 * The error's `name` is shown and its message is NOT: a message body can carry server text. React
 * unmounts the whole tree on an uncaught render error, so without a boundary one throw blanks the
 * console and the operator cannot tell it apart from the gateway being down.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, route: window.location.pathname };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[consola] ${this.props.label} falló con ${error.name}`, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.clear();
  }

  private clear(): void {
    this.setState((current) => ({ attempt: current.attempt + 1, error: undefined, route: undefined }));
  }

  private readonly retry = (): void => {
    this.clear();
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error, route, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="state-card state-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div className="state-card-texto">
          <h2>{this.props.label} no se pudo dibujar</h2>
          <p>Tipo de fallo: {error.name}</p>
          <p>Ruta: {route}</p>
          <button type="button" className="button secondary" onClick={this.retry}>
            <RefreshCw size={16} aria-hidden="true" /> Reintentar esta vista
          </button>
        </div>
      </div>
    );
  }
}
