import { useState } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { DiagnosticChain, DiagnosticChainItem } from '../../api/client/system-client';
import { Button, Notice, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { compactId } from '../../lib';

function chainError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) {
    return 'No hay una cadena para ese identificador. Puede que no exista o que esta cuenta no pueda verla.';
  }
  return cause instanceof Error ? cause.message : 'El servidor no dijo por qué.';
}

function nodeLabel(item: DiagnosticChainItem): string {
  return item.action ?? item.state ?? item.decision ?? item.alias ?? '';
}

/** Looks up one diagnostic chain by message, delivery, trace, session, operation or backup id. */
export function DiagnosticChainPanel() {
  const api = useApi();
  const [identifier, setIdentifier] = useState('');
  const [chain, setChain] = useState<DiagnosticChain>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function consult() {
    const value = identifier.trim();
    if (value.length === 0) {
      setError('Escribe el identificador de la cadena.');
      setChain(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setChain(await api.getDiagnosticChain(value));
    } catch (cause: unknown) {
      setChain(undefined);
      setError(chainError(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard
      title="Consultar una cadena"
      description="El identificador puede ser un mensaje, una entrega, una traza, una sesión, una operación o una copia. La lista es la que el servidor puede demostrar."
      className="mb-4"
    >
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void consult(); }}>
        <label className="grid min-w-0 flex-1 basis-64 gap-1 text-xs text-muted">
          Identificador
          <input
            value={identifier}
            className="w-full"
            spellCheck={false}
            onChange={(event) => { setIdentifier(event.target.value); }}
          />
        </label>
        <Button type="submit" disabled={loading}>{loading ? 'Consultando cadena…' : 'Consultar cadena'}</Button>
      </form>
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      {chain ? (
        chain.items.length === 0
          ? <EmptyState>El servidor devolvió una cadena vacía para <span className="mono">{chain.id}</span>.</EmptyState>
          : <>
            {chain.truncated ? <Notice tone="warn" role="status">La cadena está recortada: el servidor no entregó todos los nodos.</Notice> : null}
            <ul className="m-0 grid list-none gap-1 p-0" aria-label="Cadena diagnóstica">
              {chain.items.map((item) => {
                const detail = nodeLabel(item);
                return (
                  <li key={`${item.type}:${item.id}`} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                    <strong>{item.type}</strong>
                    <span className="mono break-all" title={item.id}>{compactId(item.id)}</span>
                    <span className="sr-only">{item.id}</span>
                    {detail ? <span className="text-fg-2">{detail}</span> : null}
                  </li>
                );
              })}
            </ul>
          </>
      ) : null}
    </SectionCard>
  );
}
