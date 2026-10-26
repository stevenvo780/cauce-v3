import { useId, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Notice, SectionCard } from '../../components/kit';
import { NativeContextRepositoryPanel } from './NativeContextRepositoryPanel';

interface Props { tenantId: string; alias: string; canApply?: boolean; blocked?: boolean; refreshRevision?: number;
  onSettled?: () => void; onWriteInFlightChange?: (value: boolean) => void }

/** Capability gate and commit inputs for the native manual inspection of the broker repository. */
export function ContextRepositoryPanel(props: Props) {
  // Typed commits belong to one agent: another agent starts from scratch.
  return <RepositoryContent key={`${props.tenantId}/${props.alias}`} {...props} />;
}

function RepositoryContent({ tenantId, alias }: Props) {
  const api = useApi();
  const capability = useResource(`context-repository/${tenantId}/${alias}`, () => api.getContextRepository(tenantId, alias));
  const [commit, setCommit] = useState('');
  const [previous, setPrevious] = useState('');
  const id = useId();

  if (capability.loading) return <p role="status" className="m-0 text-muted">Consultando la vinculación Git…</p>;
  if (capability.error) return <Notice tone="danger" role="alert" className="flex flex-wrap items-center justify-between gap-2">
    <p>No se pudo consultar la vinculación Git de este agente.</p>
    <ActionButton size="sm" label="Reintentar" pendingLabel="Reintentando…" done={false} announceError={false} action={() => capability.reload()} />
  </Notice>;
  if (capability.data?.state === 'not_published') return <p className="m-0 text-muted">Este servidor todavía no publica la inspección Git.</p>;
  if (capability.data?.state !== 'configured') return <p className="m-0 text-muted">Esta instancia todavía no tiene un repositorio Git vinculado por el servidor.</p>;

  return <div className="grid gap-4">
    <SectionCard title="Versiones Git del contexto"
      description={`Repositorio vinculado a la instancia ${capability.data.instance_id ?? ''}. Inspecciona el manual nativo de ${alias} en un commit del repositorio del broker. Inspeccionar no cambia el perfil ni los archivos; el contexto vigente se edita como archivos versionados en esta misma ficha.`}>
      <div className="grid gap-3 md:grid-cols-2">
        <label htmlFor={`${id}-commit`}>Commit completo
          <input id={`${id}-commit`} value={commit} maxLength={64} autoComplete="off" spellCheck={false} className="font-mono"
            onChange={(event) => { setCommit(event.target.value); }} aria-describedby={`${id}-help`} />
        </label>
        <label htmlFor={`${id}-previous`}>Comparar con otro commit (opcional)
          <input id={`${id}-previous`} value={previous} maxLength={64} autoComplete="off" spellCheck={false} className="font-mono"
            onChange={(event) => { setPrevious(event.target.value); }} aria-describedby={`${id}-help`} />
        </label>
        <p id={`${id}-help`} className="m-0 text-xs text-muted md:col-span-2">
          Identificador hexadecimal completo de 40 o 64 caracteres del repositorio compartido del broker.
        </p>
      </div>
      <NativeContextRepositoryPanel tenantId={tenantId} alias={alias} instanceId={capability.data.instance_id ?? ''} commit={commit} previous={previous} />
    </SectionCard>
  </div>;
}
