import { useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigMutation, ConfigurationSnapshot, ConsoleAccess } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import { executeConfigurationChange, textoRecarga } from '../config/config-change';
import { describeRegistryError, redactPreview, type RegistryContext } from './registry';

interface RegistryNotice {
  text: string;
  tone: 'success' | 'error' | 'parcial';
}

export interface RegistryMutationRunner {
  canWrite: boolean;
  busy: boolean;
  notice?: RegistryNotice;
  preview?: string;
  expectedRevision?: number;
  /** true only if the server has already validated THIS exact mutation in a dry-run. */
  isValidated: (mutation: ConfigMutation) => boolean;
  run: (mutation: ConfigMutation, dryRun: boolean) => Promise<boolean>;
  clear: () => void;
}

function key(mutation: ConfigMutation): string {
  return JSON.stringify(mutation);
}

interface ValidatedMutation {
  mutationKey: string;
  expectedRevision: number | undefined;
}

/**
 * The only write path for the pool screens: `changeConfiguration()`, dry-run first and apply
 * after, exactly like ConfigPage. Apply stays disabled until the server has validated the EXACT
 * mutation that is about to be applied; any form edit invalidates the previous dry-run because
 * it changes the key.
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
  const [validated, setValidated] = useState<ValidatedMutation>();
  const [chainedRevision, setChainedRevision] = useState<number>();

  const canWrite = permissionState(
    options.access.error ? undefined : options.access.data,
    'config.write',
  ) === 'allowed';
  const snapshotRevision = typeof options.config.data?.revision === 'number' ? options.config.data.revision : undefined;
  // Like ConfigPage: the snapshot reload is async, so until it catches up to the revision returned
  // by the last apply, that revision is the only expected value.
  const expectedRevision = chainedRevision !== undefined
    && (snapshotRevision === undefined || snapshotRevision < chainedRevision)
    ? chainedRevision
    : snapshotRevision;

  function clear() {
    setNotice(undefined);
    setPreview(undefined);
    setValidated(undefined);
  }

  async function run(mutation: ConfigMutation, dryRun: boolean): Promise<boolean> {
    if (!canWrite) {
      setNotice({ text: 'Cambio bloqueado: no tenés permiso para escribir configuración, o no se pudo leer el permiso. Ante la duda, cerrado.', tone: 'error' });
      return false;
    }
    const mutationKey = key(mutation);
    const isCurrentPreview = validated?.mutationKey === mutationKey
      && validated.expectedRevision === expectedRevision;
    if (!dryRun && !isCurrentPreview) {
      setNotice({ text: 'Primero hay que previsualizar exactamente esta mutación sobre la revisión visible: el apply sólo se habilita sobre el dry-run que el servidor ya aceptó.', tone: 'error' });
      return false;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = await executeConfigurationChange({
        mutation,
        dryRun,
        expectedRevision,
        change: (next, changeOptions) => api.changeConfiguration(next, changeOptions),
        reload: options.config.reload,
        describeError: (error) => describeRegistryError(error, mutation, options.context),
      });
      if (!outcome.ok) {
        if (outcome.conflict) {
          setChainedRevision(undefined);
          setValidated(undefined);
          setPreview(undefined);
        }
        if (outcome.uncertain !== undefined) {
          setValidated(undefined);
          setPreview(undefined);
        }
        setNotice({
          text: outcome.message + textoRecarga(outcome.recarga),
          tone: 'error',
        });
        return false;
      }
      const { result } = outcome;
      if (dryRun) {
        setValidated({ mutationKey, expectedRevision });
        setPreview(redactPreview(result));
        setNotice({ text: `Dry-run aceptado: ${result.summary ?? 'el servidor no devolvió resumen'}. Revisá el resultado antes de aplicar.`, tone: 'success' });
        return true;
      }
      setValidated(undefined);
      setPreview(undefined);
      if (typeof result.revision === 'number') setChainedRevision(result.revision);
      const recarga = outcome.recarga;
      setNotice({
        text: `Aplicado en revisión ${String(result.revision ?? '')}: ${result.summary ?? ''}.`
          + (recarga && !recarga.releido
            ? ` PERO la relectura del inventario no llegó (${recarga.motivo}); lo visible puede estar vencido.`
            : ` Inventario releído en revisión ${String(recarga?.revision ?? 'no informada')}.`),
        tone: recarga && !recarga.releido ? 'parcial' : 'success',
      });
      return true;
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
    isValidated: (mutation) => validated?.mutationKey === key(mutation)
      && validated.expectedRevision === expectedRevision,
    run,
    clear,
  };
}
