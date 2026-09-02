import { useState } from 'react';
import { useApi } from '../../api/context';
import type {
  ConfigMutation, ConfigurationChangeResult, ConfigurationSnapshot, ConsoleAccess,
} from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import {
  executeConfigurationChange, textoRecarga,
  type CaminoDeCambio, type ConfigChangeOutcome,
} from './config-change';

export interface ConfigMutationNotice {
  text: string;
  tone: 'success' | 'error' | 'parcial';
  /**
   * What the notice is true FOR, when the channel paints outcomes next to several controls (one
   * per table row, per collection…). The caller compares it against the scope it is rendering and
   * drops the notice as soon as they diverge, instead of asserting it over data that refuted it.
   */
  alcance?: string;
}

const BLOQUEO_POR_DEFECTO = 'Cambio bloqueado: no tenés permiso para escribir configuración, o no se pudo leer el permiso. Ante la duda, cerrado.';

const SIN_DRY_RUN = 'Primero hay que previsualizar exactamente esta mutación sobre la revisión visible: el apply sólo se habilita sobre el dry-run que el servidor ya aceptó.';

export interface ConfigMutationRunner {
  /**
   * Name of this channel, for the slots that label the notice they paint (`data-canal`) and for the
   * tests that tell them apart. What keeps the outcomes independent is one runner per control: the
   * notice of the raw editor, of a rollback and of a row action are different assertions, and
   * painting them into a single slot made a failing rollback look like a working one.
   */
  canal: string;
  canWrite: boolean;
  busy: boolean;
  notice?: ConfigMutationNotice;
  preview?: string;
  expectedRevision?: number;
  /** true only if the server has already validated THIS exact mutation in a dry-run. */
  isValidated: (mutation: ConfigMutation) => boolean;
  /** Dry-run first, apply after, with the wording of the pool screens. */
  run: (mutation: ConfigMutation, dryRun: boolean) => Promise<boolean>;
  /** The write itself, for callers that compose their own wording out of the outcome. */
  change: (
    mutation: ConfigMutation, dryRun: boolean, camino?: CaminoDeCambio,
  ) => Promise<ConfigChangeOutcome>;
  /** Marks the channel busy while a write that is NOT `changeConfiguration` is in flight. */
  ocupar: <T>(tarea: () => Promise<T>) => Promise<T>;
  informar: (notice: ConfigMutationNotice | undefined) => void;
  mostrar: (preview: string | undefined) => void;
  encadenar: (revision: number | undefined) => void;
  clear: () => void;
}

export interface RevisionEncadenada {
  revision: number | undefined;
  encadenar: (revision: number | undefined) => void;
}

/**
 * The chained revision, held ONCE for every channel writing the same configuration. The chain
 * describes the server's state, not the control that wrote it: when a write lands but its reread
 * fails, the snapshot stays at the pre-write revision, so a channel chaining on its own would send
 * that stale one on the operator's next click and get a 409 blaming another operator for a change
 * this same operator made a click earlier. Callers whose runners write disjoint state leave it out.
 */
export function useRevisionEncadenada(): RevisionEncadenada {
  const [revision, setRevision] = useState<number>();
  return { revision, encadenar: setRevision };
}

export interface ConfigMutationOptions {
  config: Resource<ConfigurationSnapshot>;
  access: Resource<ConsoleAccess>;
  canal?: string;
  encadenado?: RevisionEncadenada;
  /** Answer every write with this while writing is blocked, instead of the RBAC refusal. */
  bloqueo?: string;
  fallback?: string;
  describeError?: (error: unknown, mutation: ConfigMutation) => { message: string; conflict: boolean };
  /** How a dry-run result reaches the screen; by default, verbatim. */
  redactar?: (result: ConfigurationChangeResult) => string;
}

function key(mutation: ConfigMutation): string {
  return JSON.stringify(mutation);
}

interface ValidatedMutation {
  mutationKey: string;
  expectedRevision: number | undefined;
}

/**
 * The only write path against `POST /v3/console/config/changes`: it owns the busy flag, the
 * expected revision (including the chaining the async reload needs), the permission gate and the
 * outcome the channel is painting. Apply stays disabled until the server has validated the EXACT
 * mutation that is about to be applied; any form edit invalidates the previous dry-run because it
 * changes the key.
 */
export function useConfigMutation(options: ConfigMutationOptions): ConfigMutationRunner {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ConfigMutationNotice>();
  const [preview, setPreview] = useState<string>();
  const [validated, setValidated] = useState<ValidatedMutation>();
  const [revisionPropia, setRevisionPropia] = useState<number>();
  const chainedRevision = options.encadenado ? options.encadenado.revision : revisionPropia;
  const setChainedRevision = options.encadenado?.encadenar ?? setRevisionPropia;

  const permitido = permissionState(
    options.access.error ? undefined : options.access.data,
    'config.write',
  ) === 'allowed';
  const bloqueo = options.bloqueo ?? (permitido ? undefined : BLOQUEO_POR_DEFECTO);
  const snapshotRevision = typeof options.config.data?.revision === 'number' ? options.config.data.revision : undefined;
  // The snapshot reload is async and the wizard chains mutations: until the reread catches up to
  // the revision the last apply returned, that revision is the only expected value.
  const expectedRevision = chainedRevision !== undefined
    && (snapshotRevision === undefined || snapshotRevision < chainedRevision)
    ? chainedRevision
    : snapshotRevision;

  async function ocupar<T>(tarea: () => Promise<T>): Promise<T> {
    setBusy(true);
    try {
      return await tarea();
    } finally {
      setBusy(false);
    }
  }

  async function change(
    mutation: ConfigMutation, dryRun: boolean, camino?: CaminoDeCambio,
  ): Promise<ConfigChangeOutcome> {
    if (bloqueo !== undefined) return { ok: false, conflict: false, message: bloqueo };
    const describeError = options.describeError;
    return ocupar(async () => {
      const outcome = await executeConfigurationChange({
        mutation,
        dryRun,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        change: (next, changeOptions) => api.changeConfiguration(next, changeOptions),
        reload: options.config.reload,
        ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
        ...(camino === undefined ? {} : { camino }),
        ...(describeError === undefined ? {} : { describeError: (error: unknown) => describeError(error, mutation) }),
      });
      if (outcome.ok) {
        if (!dryRun && typeof outcome.result.revision === 'number') setChainedRevision(outcome.result.revision);
      } else if (outcome.conflict) {
        setChainedRevision(undefined);
      }
      return outcome;
    });
  }

  async function run(mutation: ConfigMutation, dryRun: boolean): Promise<boolean> {
    if (bloqueo !== undefined) {
      setNotice({ text: bloqueo, tone: 'error' });
      return false;
    }
    const mutationKey = key(mutation);
    const isCurrentPreview = validated?.mutationKey === mutationKey
      && validated.expectedRevision === expectedRevision;
    if (!dryRun && !isCurrentPreview) {
      setNotice({ text: SIN_DRY_RUN, tone: 'error' });
      return false;
    }
    setNotice(undefined);
    const outcome = await change(mutation, dryRun);
    if (!outcome.ok) {
      if (outcome.conflict || outcome.uncertain !== undefined) {
        setValidated(undefined);
        setPreview(undefined);
      }
      setNotice({ text: outcome.message + textoRecarga(outcome.recarga), tone: 'error' });
      return false;
    }
    const { result } = outcome;
    if (dryRun) {
      setValidated({ mutationKey, expectedRevision });
      setPreview(options.redactar ? options.redactar(result) : JSON.stringify(result, null, 2));
      setNotice({ text: `Dry-run aceptado: ${result.summary ?? 'el servidor no devolvió resumen'}. Revisá el resultado antes de aplicar.`, tone: 'success' });
      return true;
    }
    setValidated(undefined);
    setPreview(undefined);
    const recarga = outcome.recarga;
    setNotice({
      text: `Aplicado en revisión ${String(result.revision ?? '')}: ${result.summary ?? ''}.`
        + (recarga && !recarga.releido
          ? ` PERO la relectura del inventario no llegó (${recarga.motivo}); lo visible puede estar vencido.`
          : ` Inventario releído en revisión ${String(recarga?.revision ?? 'no informada')}.`),
      tone: recarga && !recarga.releido ? 'parcial' : 'success',
    });
    return true;
  }

  return {
    canal: options.canal ?? 'principal',
    canWrite: bloqueo === undefined,
    busy,
    notice,
    preview,
    expectedRevision,
    isValidated: (mutation) => validated?.mutationKey === key(mutation)
      && validated.expectedRevision === expectedRevision,
    run,
    change,
    ocupar,
    informar: setNotice,
    mostrar: setPreview,
    encadenar: setChainedRevision,
    clear: () => {
      setNotice(undefined);
      setPreview(undefined);
      setValidated(undefined);
    },
  };
}
