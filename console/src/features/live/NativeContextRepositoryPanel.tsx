import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { NativeContextRepositoryInspection, NativeSourceFile } from '../../api/client/native-context-repository-client';
import { authSessionKey } from '../auth/account-identity';
import { Button, Notice } from '../../components/form-kit';

interface Props { tenantId: string; alias: string; instanceId: string; commit: string; previous: string }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MONO = 'm-0 break-words whitespace-pre-wrap font-mono text-xs text-fg-2';
const LABELS = { added: 'Fuente añadida', removed: 'Fuente retirada', modified: 'Fuente modificada' };

export function NativeContextRepositoryPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="min-w-0 rounded-lg border border-line px-3 py-2" onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary className="cursor-pointer text-[13px] font-medium">Manual nativo de Git · sólo inspección</summary>
    {open ? <NativeInspection key={JSON.stringify([props.tenantId, props.alias, props.instanceId, props.commit, props.previous])} {...props} /> : null}
  </details>;
}

function Source({ file, label }: { file: NativeSourceFile; label: string }) {
  return <section className="grid gap-1 border-t border-line pt-2">
    <h5 className="m-0 text-[13px] font-semibold">{label}</h5>
    <p className={MONO}>Fuente: {file.path}</p>
    <p className={MONO}>SHA-256: {file.sha256} · {file.bytes} bytes</p>
    <pre className={`${MONO} max-h-96 overflow-auto rounded-md bg-subtle p-2`}>{file.content || 'Archivo vacío'}</pre>
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
  return <div className="grid gap-2 pt-2">
    <p className="m-0 text-xs text-muted">Usá los commits indicados arriba. Fuente Git declarada; archivo vigente, runtime y adopción de sesión no comprobados. No se puede aplicar desde este visor.</p>
    <div><Button size="sm" disabled={(current?.busy ?? false) || !OID.test(commit) || (previous !== '' && !OID.test(previous))}
      onClick={() => { void inspect(); }}>{current?.busy ? 'Inspeccionando manual…' : current?.error ? 'Reintentar manual' : 'Inspeccionar manual'}</Button></div>
    {current?.busy ? <p role="status" className="m-0 text-xs text-muted">Consultando el manual nativo…</p> : null}
    {current?.error ? <Notice tone="danger" role="alert">{current.error}</Notice> : null}
    {current?.result ? <NativeResult result={current.result} /> : null}
  </div>;
}

function NativeResult({ result }: { result: NativeContextRepositoryInspection }) {
  return <section aria-label="Inspección de manual nativo" className="grid gap-2 text-[13px]">
    <p className="m-0">Arnés declarado: {result.desired.sourceAgent.native_manual.harness}</p>
    <p className={MONO}>Commit: {result.desired.commit}</p>
    <p className={MONO}>Árbol: {result.desired.tree}</p>
    <Source label="Manual de la versión consultada" file={result.desired.manualSource} />
    {result.previous ? <>
      <p className={MONO}>Comparación: {result.previous.commit} · Árbol: {result.previous.tree}</p>
      <p className="m-0">Arnés anterior declarado: {result.previous.sourceAgent.native_manual.harness}</p>
      {result.changes?.length === 0 ? <p className="m-0">Sin cambios en las fuentes del perfil y del manual.</p> : null}
      {result.changes?.map((change) => <details key={change.path}>
        <summary className="cursor-pointer text-xs font-medium">{LABELS[change.kind]}: {change.path}</summary>
        {change.before ? <Source label="Antes" file={change.before} /> : null}
        {change.after ? <Source label="Después" file={change.after} /> : null}
      </details>)}
    </> : null}
  </section>;
}
