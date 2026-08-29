import { useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigMutation, ConfigurationSnapshot, ConsoleAccess } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import { exactConfigurationReceipt } from '../config/config-receipt';
import { describeRegistryError, redactPreview, type RegistryContext } from './registry';

export interface RegistryNotice {
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
  const [validatedKey, setValidatedKey] = useState<string>();
  const [chainedRevision, setChainedRevision] = useState<number>();

  const canWrite = permissionState(options.access.data, 'config.write') === 'allowed';
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
    setValidatedKey(undefined);
  }

  async function run(mutation: ConfigMutation, dryRun: boolean): Promise<boolean> {
    if (!canWrite) {
      setNotice({ text: 'Cambio bloqueado: no tenés permiso para escribir configuración, o no se pudo leer el permiso. Ante la duda, cerrado.', tone: 'error' });
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
      if (!exactConfigurationReceipt(result, dryRun, mutation)) {
        setValidatedKey(undefined);
        setPreview(undefined);
        const recarga = dryRun ? undefined : await options.config.reload();
        const desenlace = recarga === undefined
          ? ''
          : recarga.error
            ? ` La relectura tampoco llegó (${recarga.error.message}).`
            : ` Se releyó la revisión ${String(recarga.data.revision ?? 'no informada')}; verificá allí el efecto.`;
        setNotice({
          tone: 'error',
          text: dryRun
            ? 'El servidor devolvió un 2xx sin el recibo exacto del dry-run; no se habilitó aplicar.'
            : `El servidor devolvió un 2xx sin el recibo durable exacto. La escritura puede haberse aplicado; no la repitas sin conciliar.${desenlace}`,
        });
        return false;
      }
      if (dryRun) {
        setValidatedKey(mutationKey);
        setPreview(redactPreview(result));
        setNotice({ text: `Dry-run aceptado: ${result.summary ?? 'el servidor no devolvió resumen'}. Revisá el resultado antes de aplicar.`, tone: 'success' });
        return true;
      }
      setValidatedKey(undefined);
      setPreview(undefined);
      if (typeof result.revision === 'number') setChainedRevision(result.revision);
      const recarga = await options.config.reload();
      setNotice({
        text: `Aplicado en revisión ${String(result.revision ?? '')}: ${result.summary ?? ''}.`
          + (recarga.error
            ? ` PERO la relectura del inventario no llegó (${recarga.error.message}); lo visible puede estar vencido.`
            : ` Inventario releído en revisión ${String(recarga.data.revision ?? 'no informada')}.`),
        tone: recarga.error ? 'parcial' : 'success',
      });
      return true;
    } catch (error) {
      const described = describeRegistryError(error, mutation, options.context);
      if (described.conflict) {
        setChainedRevision(undefined);
        setValidatedKey(undefined);
        setPreview(undefined);
        await options.config.reload();
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
