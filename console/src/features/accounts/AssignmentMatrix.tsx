import { ArrowDownUp, Ban, Link2Off, Plus, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../cn';
import type { ConfigMutation, ConfigurationSnapshot, ConsoleAccess } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { AgentOrb } from '../../components/AgentOrb';
import { Button, CARD_TABLE, Explain, Notice, SCROLL } from '../../components/kit';
import { FormDialog } from '../../components/dialogs';
import { Badge, Desplazable, EmptyState } from '../../components/ui';
import { useConfigMutation } from '../config/use-config-mutation';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { MutationBar } from './MutationBar';
import {
  bindingMutation, ceilingMutation, describeRegistryError, redactPreview,
  type MatrixCell, type RegistryModel,
} from './registry';

type Operation = 'grant-ceiling' | 'revoke-ceiling' | 'create-binding' | 'update-binding' | 'delete-binding';

const operationLabels: Record<Operation, string> = {
  'grant-ceiling': 'Dar acceso a una cuenta',
  'revoke-ceiling': 'Quitar acceso a una cuenta',
  'create-binding': 'Agregar cuenta de respaldo',
  'update-binding': 'Cambiar orden de respaldo',
  'delete-binding': 'Quitar cuenta de respaldo',
};

interface Assignment {
  agentKey: string;
  accountId: string;
  operation: Operation;
  priority: string;
  enabled: boolean;
}

function cellBadge(cell: MatrixCell): { tone: 'online' | 'warning' | 'offline' | 'unknown'; label: string } {
  if (cell.state === 'bound-enabled') return { tone: 'online', label: `#${String(cell.rank ?? '?')} · prio ${String(cell.priority ?? 'UNKNOWN')}` };
  if (cell.state === 'bound-disabled') return { tone: 'offline', label: `binding off · prio ${String(cell.priority ?? 'UNKNOWN')}` };
  if (cell.state === 'ceiling-only') return { tone: 'warning', label: 'techo sin binding' };
  return { tone: 'unknown', label: 'sin techo' };
}

function agentKeyOf(tenantId: string, alias: string): string {
  return `${tenantId}/${alias}`;
}

/**
 * Routing writes: the ceiling (which accounts an alias may reach) and the fallback bindings that
 * order them. `config` and `access` arrive via props, not through a local `useResource`, so the
 * page reads the configuration once. The mutation runner IS its own: the inventory form and this
 * one are independent, and one dry-run must not enable the other's apply.
 */
export function AssignmentMatrix({ config, access, registry }: {
  config: Resource<ConfigurationSnapshot>;
  access: Resource<ConsoleAccess>;
  registry: RegistryModel;
}) {
  const { accounts, agents, ceiling, bindings } = registry;
  const matrix = registry.routing.matrix;
  const runner = useConfigMutation({
    config,
    access,
    canal: 'assignment-matrix',
    describeError: (error, mutation) => describeRegistryError(error, mutation, registry.context),
    redactar: redactPreview,
  });
  const writeDisabled = !runner.canWrite || runner.busy;
  const writeProps = { disabled: writeDisabled, ...(!runner.canWrite ? { title: CONFIG_SIN_CONTROL_REASON } : {}) };

  const [assignment, setAssignment] = useState<Assignment>({
    agentKey: '', accountId: '', operation: 'grant-ceiling', priority: '100', enabled: true,
  });
  const [formOpen, setFormOpen] = useState(false);

  const available = agents.available && accounts.available && ceiling.available && bindings.available;
  const missing = [
    ...(agents.available ? [] : ['agents']),
    ...(accounts.available ? [] : ['provider_accounts']),
    ...(ceiling.available ? [] : ['alias_routing_ceiling']),
    ...(bindings.available ? [] : ['agent_account_bindings']),
  ];

  function patch(next: Partial<Assignment>) {
    setAssignment((current) => ({ ...current, ...next }));
    runner.clear();
  }

  function closeForm() {
    setFormOpen(false);
    runner.clear();
  }

  function selectCell(agentKey: string, accountId: string, cell: MatrixCell) {
    setFormOpen(true);
    patch({
      agentKey,
      accountId,
      operation: cell.state === 'none' ? 'grant-ceiling'
        : cell.state === 'ceiling-only' ? 'create-binding' : 'update-binding',
      ...(cell.priority === null ? {} : { priority: String(cell.priority) }),
    });
  }

  const [selectedTenant, selectedAlias] = assignment.agentKey.split('/');
  // `Number('')` and `Number('   ')` both equal 0, and 0 is a valid priority — the highest one, in fact.
  // Without this guard, clearing the field did not ask for a value: it silently dispatched
  // `priority: 0` and the alias went on to try that account first. A 0 written on purpose stays valid.
  const priorityText = assignment.priority.trim();
  const priorityNumber = priorityText === '' ? Number.NaN : Number(priorityText);
  const priorityValid = Number.isInteger(priorityNumber) && priorityNumber >= 0 && priorityNumber <= 32_767;
  const needsPriority = assignment.operation === 'create-binding' || assignment.operation === 'update-binding';

  const invalid = !assignment.agentKey || !selectedTenant || !selectedAlias
    ? 'Elegí un agente: la mutación identifica al alias por tenant y alias.'
    : !assignment.accountId
      ? 'Elegí una cuenta.'
      : needsPriority && !priorityValid
        ? 'La prioridad debe ser un entero entre 0 y 32767; menor se intenta primero.'
        : undefined;

  const mutation: ConfigMutation | undefined = invalid || !selectedTenant || !selectedAlias ? undefined
    : assignment.operation === 'grant-ceiling'
      ? ceilingMutation('create', selectedTenant, selectedAlias, assignment.accountId)
      : assignment.operation === 'revoke-ceiling'
        ? ceilingMutation('delete', selectedTenant, selectedAlias, assignment.accountId)
        : assignment.operation === 'delete-binding'
          ? bindingMutation('delete', selectedTenant, selectedAlias, assignment.accountId)
          : bindingMutation(
            assignment.operation === 'create-binding' ? 'create' : 'update',
            selectedTenant, selectedAlias, assignment.accountId,
            { priority: priorityNumber, enabled: assignment.enabled },
          );

  const FIELD = 'grid gap-3 sm:grid-cols-2';
  const HINT = 'text-xs font-normal text-muted';

  return <div className="grid gap-4">
    {missing.length ? <Notice tone="danger" role="alert">
      No disponible: este gateway no publica {missing.map((name) => <code key={name}>{name} </code>)}
      en su configuración. La matriz se muestra incompleta a propósito; la consola no rellena lo que el servidor no informa.
    </Notice> : null}

    <section aria-label="Techo por alias">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">Techo por alias</h2>
          <p className="m-0 mt-0.5 text-xs text-muted">Tocá una celda para asignar: cada cambio pasa por una vista previa.</p>
        </div>
        <Button variant="primary" {...writeProps} onClick={() => { setFormOpen(true); }}>
          <Plus size={15} aria-hidden="true" />Nueva asignación
        </Button>
      </div>
      <Explain title="¿Cómo se rutea?">
        <p>El techo (<code>alias_routing_ceiling</code>) es el conjunto exhaustivo de cuentas a las que un alias puede llegar a rutearse; el binding sólo ordena el fallback dentro de ese techo. Un binding no puede existir fuera del techo.</p>
        <p>El intento 1 de cada delivery corre <strong>sin ningún override de entorno</strong>: el CLI usa la credencial que ya tiene logueada en su container. Por eso el orden de fallback describe únicamente los <strong>reintentos</strong>.</p>
      </Explain>
      {!available && agents.items.length === 0
        ? <EmptyState>Sin datos de agentes para cruzar.</EmptyState>
        : matrix.length === 0
          ? <EmptyState>El servidor devolvió cero agentes registrados. Un alias que hoy funciona por membresía puede no estar todavía en el registro: son dos cosas distintas.</EmptyState>
          : accounts.items.length === 0
            ? <EmptyState>No hay cuentas visibles para formar columnas.</EmptyState>
            : <Desplazable etiqueta="Matriz de techo y fallback por agente y cuenta" className={SCROLL}>
              <table className={CARD_TABLE}>
                <caption className="sr-only">Matriz de techo y fallback por agente y cuenta</caption>
                <thead><tr>
                  <th className="md:sticky md:left-0 md:z-[2]">Agente</th>
                  {accounts.items.map((account) => <th key={account.id}>
                    <span className="mono">{account.id}</span>
                    <div className={HINT}>{account.provider ?? 'UNKNOWN'} · paga {account.payerTenant ?? 'UNKNOWN'}</div>
                  </th>)}
                </tr></thead>
                <tbody>
                  {matrix.map((row) => {
                    const key = agentKeyOf(row.agent.tenantId, row.agent.alias);
                    return <tr key={key}>
                      <td className="max-md:!block max-md:!px-2 md:sticky md:left-0 md:z-[1] md:bg-surface"><div className="flex items-center gap-2">
                        <AgentOrb seed={key} size={22} />
                        <div className="min-w-0">
                          <strong>{row.agent.alias}</strong>
                          <small className="subline">{row.agent.tenantId} · harness {row.agent.harnessId ?? 'UNKNOWN'}</small>
                        </div>
                      </div></td>
                      {row.cells.map((cell) => {
                        const badge = cellBadge(cell);
                        return <td key={cell.accountId} data-label={cell.accountId}>
                          <button
                            {...writeProps}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent p-0 enabled:hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-60"
                            type="button"
                            aria-label={`${key} × ${cell.accountId}: ${badge.label}`}
                            title={cell.grantedBy ? `Techo otorgado por ${cell.grantedBy}` : undefined}
                            onClick={() => { selectCell(key, cell.accountId, cell); }}
                          >
                            <Badge tone={badge.tone}>{badge.label}</Badge>
                          </button>
                          {cell.borrowed ? <span className="chip ml-1">prestada</span> : null}
                        </td>;
                      })}
                    </tr>;
                  })}
                </tbody>
              </table>
            </Desplazable>}
    </section>

    <section aria-label="Orden de fallback efectivo">
      <h2 className="m-0 text-sm font-semibold">Orden de fallback efectivo</h2>
      <p className="m-0 mt-0.5 mb-3 text-xs text-muted">Sólo bindings habilitados y dentro del techo, de menor a mayor prioridad.</p>
      {matrix.length === 0 ? <EmptyState>Sin agentes registrados.</EmptyState> : <ul className="m-0 grid list-none gap-2 p-0" aria-label="Orden de fallback por agente">
        {matrix.map((row) => <li key={agentKeyOf(row.agent.tenantId, row.agent.alias)}
          className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px]">
          <span className="flex min-w-36 items-center gap-2">
            <AgentOrb seed={agentKeyOf(row.agent.tenantId, row.agent.alias)} size={18} />
            <strong>{row.agent.tenantId}/{row.agent.alias}</strong>
          </span>
          <div className="min-w-0 flex-1 basis-60">
            {row.fallback.length === 0
              ? <span className="unknown inline-flex items-center gap-1"><Ban size={13} aria-hidden="true" /> sin fallback: los reintentos corren igual que el intento 1</span>
              : <span className="chip-list">
                {row.fallback.map((step) => <span className="chip" key={step.accountId}>
                  <ArrowDownUp size={12} aria-hidden="true" /> {step.rank}. {step.accountId} (prio {step.priority ?? 'UNKNOWN'}){step.borrowed ? ' · prestada' : ''}
                </span>)}
              </span>}
            {row.idleCeiling.length
              ? <div className={cn(HINT, 'mt-1')}>En el techo pero sin binding habilitado: {row.idleCeiling.join(', ')}</div>
              : null}
          </div>
        </li>)}
      </ul>}
    </section>

    <FormDialog open={formOpen} onClose={closeForm} busy={runner.busy} title="Asignar" description="Cada cambio muestra una vista previa antes de confirmarlo.">
      <div className={FIELD}>
        <label>Agente
          <select {...writeProps} value={assignment.agentKey} onChange={(event) => { patch({ agentKey: event.target.value }); }}>
            <option value="">— elegir —</option>
            {agents.items.map((agent) => {
              const key = agentKeyOf(agent.tenantId, agent.alias);
              return <option key={key} value={key}>{key}</option>;
            })}
          </select>
        </label>
        <label>Cuenta
          <select {...writeProps} value={assignment.accountId} onChange={(event) => { patch({ accountId: event.target.value }); }}>
            <option value="">— elegir —</option>
            {accounts.items.map((account) => <option key={account.id} value={account.id}>
              {account.id} · paga {account.payerTenant ?? 'UNKNOWN'}{account.sharedWithPool === true ? ' · en el pool' : ''}
            </option>)}
          </select>
        </label>
        <label className="sm:col-span-2">Operación
          <select {...writeProps} value={assignment.operation} onChange={(event) => { patch({ operation: event.target.value as Operation }); }}>
            {(Object.keys(operationLabels) as Operation[]).map((operation) => <option key={operation} value={operation}>{operationLabels[operation]}</option>)}
          </select>
        </label>
        {needsPriority ? <label>Prioridad <span className={HINT}>0–32767, menor se intenta primero</span>
          <input {...writeProps} value={assignment.priority} onChange={(event) => { patch({ priority: event.target.value }); }} />
        </label> : null}
        {needsPriority ? <label className="flex items-center gap-2 self-end font-normal"><input {...writeProps} type="checkbox" checked={assignment.enabled} onChange={(event) => { patch({ enabled: event.target.checked }); }} /> Binding habilitado</label> : null}
      </div>
      {assignment.operation === 'revoke-ceiling' ? <Notice role="note" className="flex items-start gap-1.5">
        <Link2Off size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> Revocar el techo borra en cascada el binding de ese alias hacia esa cuenta: la revocación no depende del orden en que se hagan las cosas.
      </Notice> : null}
      {assignment.operation === 'grant-ceiling' ? <Notice role="note" className="flex items-start gap-1.5">
        <ShieldQuestion size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> Si la cuenta la paga otro tenant, sólo se puede otorgar cuando su pagador la publicó al pool. Ese consentimiento lo verifica Postgres, no la consola.
      </Notice> : null}
      <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="asignación" />
    </FormDialog>
  </div>;
}
