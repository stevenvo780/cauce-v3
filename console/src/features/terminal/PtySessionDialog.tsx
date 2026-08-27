import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Container,
  KeyRound,
  TerminalSquare,
  UserCog,
} from 'lucide-react';
import { Unknown } from '../../components/ui';
import type { DenegacionExplicada } from './denegaciones';
import type { FleetAgent, TerminalTargetResolution } from './fleet';
import { ptyReasonProblem, PTY_REASON_MAX_LENGTH } from './session';

export function NegativaPty({ negativa }: { negativa: DenegacionExplicada }) {
  return (
    <div
      className="pty-negativa"
      role="alert"
      data-codigo={negativa.codigo}
      data-consola={negativa.esDefectoDeLaConsola || undefined}
    >
      <strong>{negativa.titulo}</strong>
      <p>{negativa.porQue}</p>
      {negativa.quienLoLevanta ? <p className="pty-negativa-quien"><KeyRound size={13} aria-hidden="true" /> Lo levanta: {negativa.quienLoLevanta}</p> : null}
    </div>
  );
}

export function PtySessionDialog({ agent, resolution, pending, error, onCancel, onConfirm }: {
  agent: FleetAgent;
  resolution: TerminalTargetResolution;
  pending: boolean;
  error?: DenegacionExplicada;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const target = resolution.target;
  const problem = ptyReasonProblem(reason);
  const shared = target?.shares_container_with ?? [];
  const sharedLabels = shared.map((identity) =>
    identity.tenant_id === target?.tenant_id ? identity.alias : `${identity.tenant_id}:${identity.alias}`);

  useEffect(() => { reasonRef.current?.focus(); }, []);

  return (
    <div className="pty-dialog-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
      <div className="pty-dialog" role="dialog" aria-modal="true" aria-labelledby="pty-dialog-title" aria-describedby="pty-dialog-scope">
        <header>
          <p className="eyebrow">Sesión interactiva</p>
          <h2 id="pty-dialog-title">Abrir PTY en {agent.alias}</h2>
        </header>

        <dl className="pty-dialog-facts" id="pty-dialog-scope">
          <div><dt><Container size={13} aria-hidden="true" /> Contenedor</dt><dd className="mono"><Unknown value={target?.container} /></dd></div>
          <div><dt><UserCog size={13} aria-hidden="true" /> Usuario destino</dt><dd className="mono"><Unknown value={target?.runtime_user} /></dd></div>
          <div><dt><TerminalSquare size={13} aria-hidden="true" /> Modo</dt><dd className="mono">{target?.modes[0] ?? 'shell'}</dd></div>
        </dl>

        {shared.length ? (
          <p className="pty-dialog-shared" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              Este contenedor lo comparten <strong>{sharedLabels.join(', ')}</strong>. Una shell acá no es “la terminal de {agent.alias}”:
              es acceso al home donde conviven {[agent.alias, ...sharedLabels].join(', ')}.
            </span>
          </p>
        ) : (
          <p className="pty-dialog-solo">El servidor no reporta otros agentes en este contenedor.</p>
        )}

        <label className="pty-dialog-reason" htmlFor="pty-dialog-reason">
          Motivo de la sesión (queda en la auditoría)
          <textarea
            id="pty-dialog-reason"
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={PTY_REASON_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder="Escribí por qué necesitás esta shell…"
            aria-describedby="pty-dialog-reason-hint"
          />
        </label>
        <p className="pty-dialog-hint" id="pty-dialog-reason-hint">{problem ?? `Motivo válido · ${reason.trim().length}/${PTY_REASON_MAX_LENGTH}`}</p>

        {error ? <NegativaPty negativa={error} /> : null}

        <div className="pty-dialog-actions">
          <button className="button secondary" type="button" onClick={onCancel} disabled={pending}>Cancelar</button>
          <button
            className="button primary"
            type="button"
            disabled={Boolean(problem) || pending}
            title={problem}
            onClick={() => onConfirm(reason.trim())}
          >
            <TerminalSquare size={15} aria-hidden="true" /> {pending ? 'Solicitando…' : 'Abrir sesión PTY'}
          </button>
        </div>
      </div>
    </div>
  );
}
