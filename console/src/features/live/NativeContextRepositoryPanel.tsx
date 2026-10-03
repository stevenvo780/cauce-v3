import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { NativeContextRepositoryInspection, NativeSourceFile } from '../../api/client/native-context-repository-client';
import { authSessionKey } from '../auth/account-identity';
import './native-context-repository.css';

interface Props { tenantId: string; alias: string; instanceId: string; commit: string; previous: string }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const LABELS = { added: 'Fuente añadida', removed: 'Fuente retirada', modified: 'Fuente modificada' };

export function NativeContextRepositoryPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="native-context-repository" onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>Manual nativo de Git · sólo inspección</summary>
    {open ? <NativeInspection key={JSON.stringify([props.tenantId, props.alias, props.instanceId, props.commit, props.previous])} {...props} /> : null}
  </details>;
}

function Source({ file, label }: { file: NativeSourceFile; label: string }) {
  return <section className="historial-diff-campo">
    <h5>{label}</h5>
    <p className="historial-diff-texto">Fuente: {file.path}</p>
    <p className="historial-diff-texto">SHA-256: {file.sha256} · {file.bytes} bytes</p>
    <pre className="native-context-source">{file.content || 'Archivo vacío'}</pre>
  </section>;
}

function NativeInspection({ tenantId, alias, instanceId, commit, previous }: Props) {
  const api = useApi();
  const [state, setState] = useState<{ api: typeof api; result?: NativeContextRepositoryInspection; error?: string; busy?: boolean }>({ api });
  const sequence = useRef(0);
  const session = useRef<string | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = api.onAuthSession((value) => {
      const key = authSessionKey(value);
      if (session.current !== key) { session.current = key; sequence.current += 1; setState({ api }); }
    });
    return () => { sequence.current += 1; unsubscribe(); };
  }, [api]);
  const current = state.api === api ? state : undefined;
  async function inspect() {
    if (current?.busy || !OID.test(commit) || (previous !== '' && !OID.test(previous))) return;
    const request = ++sequence.current;
    setState({ api, busy: true });
    try {
      const result = await api.inspectNativeContextRepository(tenantId, alias, instanceId, commit, previous || undefined);
      if (request === sequence.current) setState({ api, result });
    } catch {
      if (request === sequence.current) setState({ api, error: 'No se pudo inspeccionar el manual. Comprobá los commits y que el repositorio declare un manual nativo v3.' });
    }
  }
  return <div>
    <p className="muted">Usá los commits indicados arriba. Fuente Git declarada; archivo vigente, runtime y adopción de sesión no comprobados. No se puede aplicar desde este visor.</p>
    <button type="button" className="button small secondary" disabled={(current?.busy ?? false) || !OID.test(commit) || (previous !== '' && !OID.test(previous))}
      onClick={() => { void inspect(); }}>{current?.busy ? 'Inspeccionando manual…' : current?.error ? 'Reintentar manual' : 'Inspeccionar manual'}</button>
    {current?.busy ? <p role="status">Consultando el manual nativo…</p> : null}
    {current?.error ? <p role="alert">{current.error}</p> : null}
    {current?.result ? <NativeResult result={current.result} /> : null}
  </div>;
}

function NativeResult({ result }: { result: NativeContextRepositoryInspection }) {
  return <section aria-label="Inspección de manual nativo" className="historial-diff">
    <p>Arnés declarado: {result.desired.sourceAgent.native_manual.harness}</p>
    <p className="historial-diff-texto">Commit: {result.desired.commit}</p>
    <p className="historial-diff-texto">Árbol: {result.desired.tree}</p>
    <Source label="Manual de la versión consultada" file={result.desired.manualSource} />
    {result.previous ? <>
      <p className="historial-diff-texto">Comparación: {result.previous.commit} · Árbol: {result.previous.tree}</p>
      <p>Arnés anterior declarado: {result.previous.sourceAgent.native_manual.harness}</p>
      {result.changes?.length === 0 ? <p>Sin cambios en las fuentes del perfil y del manual.</p> : null}
      {result.changes?.map((change) => <details key={change.path}>
        <summary>{LABELS[change.kind]}: {change.path}</summary>
        {change.before ? <Source label="Antes" file={change.before} /> : null}
        {change.after ? <Source label="Después" file={change.after} /> : null}
      </details>)}
    </> : null}
  </section>;
}
