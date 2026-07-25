import { useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigMutation, ConfigurationSnapshot, ConsoleAccess } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import { describeRegistryError, redactPreview, type RegistryContext } from './registry';

export interface RegistryNotice {
  text: string;
  tone: 'success' | 'error';
}

export interface RegistryMutationRunner {
  canWrite: boolean;
  busy: boolean;
  notice?: RegistryNotice;
  preview?: string;
  expectedRevision?: number;
  /** true sólo si el servidor ya validó en dry-run ESTA mutación exacta. */
  isValidated: (mutation: ConfigMutation) => boolean;
  run: (mutation: ConfigMutation, dryRun: boolean) => Promise<boolean>;
  clear: () => void;
}

function key(mutation: ConfigMutation): string {
  return JSON.stringify(mutation);
}

/**
 * Único camino de escritura de las pantallas del pool: `changeConfiguration()`, dry-run primero y
 * apply después, exactamente como ConfigPage. El apply queda deshabilitado hasta que el servidor
 * validó la mutación EXACTA que se va a aplicar; cualquier edición del formulario invalida el
 * dry-run anterior porque cambia la clave.
 */
export function useRegistryMutation(options: {
  config: Resource<ConfigurationSnapshot>;
  access: Resource<ConsoleAccess>;
  context: RegistryContext;
}): RegistryMutationRunner {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<RegistryNotice>();
  const [preview, setPreview] = useState<string>();
  const [validatedKey, setValidatedKey] = useState<string>();
  const [chainedRevision, setChainedRevision] = useState<number>();

  const canWrite = permissionState(options.access.data, 'config.write') === 'allowed';
  const snapshotRevision = typeof options.config.data?.revision === 'number' ? options.config.data.revision : undefined;
  // Igual que ConfigPage: la recarga del snapshot es asíncrona, así que hasta que alcanza la
  // revisión que devolvió el último apply, esa revisión es la única esperada verdadera.
  const expectedRevision = chainedRevision !== undefined
    && (snapshotRevision === undefined || snapshotRevision < chainedRevision)
    ? chainedRevision
    : snapshotRevision;

  function clear() {
    setNotice(undefined);
    setPreview(undefined);
    setValidatedKey(undefined);
  }

  async function run(mutation: ConfigMutation, dryRun: boolean): Promise<boolean> {
    if (!canWrite) {
      setNotice({ text: 'Cambio bloqueado: el permiso RBAC config.write está en DENY o UNKNOWN.', tone: 'error' });
      return false;
    }
    const mutationKey = key(mutation);
    if (!dryRun && validatedKey !== mutationKey) {
      setNotice({ text: 'Primero hay que previsualizar exactamente esta mutación: el apply sólo se habilita sobre el dry-run que el servidor ya aceptó.', tone: 'error' });
      return false;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.changeConfiguration(mutation, {
        dryRun,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      if (dryRun) {
        setValidatedKey(mutationKey);
        setPreview(redactPreview(result));
        setNotice({ text: `Dry-run aceptado: ${result.summary ?? 'el servidor no devolvió resumen'}. Revisá el resultado antes de aplicar.`, tone: 'success' });
        return true;
      }
      setValidatedKey(undefined);
      setPreview(undefined);
      if (typeof result.revision === 'number') setChainedRevision(result.revision);
      options.config.reload();
      setNotice({ text: `Aplicado en revisión ${result.revision ?? 'UNKNOWN'}: ${result.summary ?? 'el servidor no devolvió resumen'}.`, tone: 'success' });
      return true;
    } catch (error) {
      const described = describeRegistryError(error, mutation, options.context);
      if (described.conflict) {
        setChainedRevision(undefined);
        setValidatedKey(undefined);
        setPreview(undefined);
        options.config.reload();
      }
      setNotice({ text: described.message, tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    canWrite,
    busy,
    notice,
    preview,
    expectedRevision,
    isValidated: (mutation) => validatedKey === key(mutation),
    run,
    clear,
  };
}
