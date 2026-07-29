import { ArrowDownUp, Ban, Cpu, Link2Off, ShieldQuestion } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigMutation } from '../../api/types';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton,
} from '../../components/ui';
import { MutationBar } from './MutationBar';
import {
  bindingMutation, buildAssignmentMatrix, ceilingMutation, readAgents, readBindings, readCeiling,
  readProviderAccounts, type MatrixCell, type RegistryContext,
} from './registry';
import { useRegistryMutation } from './use-registry-mutation';

type Operation = 'grant-ceiling' | 'revoke-ceiling' | 'create-binding' | 'update-binding' | 'delete-binding';

const operationLabels: Record<Operation, string> = {
  'grant-ceiling': 'Otorgar techo (alias_routing_ceiling create)',
  'revoke-ceiling': 'Revocar techo (alias_routing_ceiling delete, cascadea el binding)',
  'create-binding': 'Crear binding de fallback (agent_account_binding create)',
  'update-binding': 'Actualizar binding de fallback (agent_account_binding update)',
  'delete-binding': 'Quitar binding de fallback (agent_account_binding delete)',
};

interface Assignment {
  agentKey: string;
  accountId: string;
  operation: Operation;
  priority: string;
  enabled: boolean;
}

function cellBadge(cell: MatrixCell): { tone: 'online' | 'warning' | 'offline' | 'unknown'; label: string } {
  if (cell.state === 'bound-enabled') return { tone: 'online', label: `#${cell.rank ?? '?'} · prio ${cell.priority ?? 'UNKNOWN'}` };
  if (cell.state === 'bound-disabled') return { tone: 'offline', label: `binding off · prio ${cell.priority ?? 'UNKNOWN'}` };
  if (cell.state === 'ceiling-only') return { tone: 'warning', label: 'techo sin binding' };
  return { tone: 'unknown', label: 'sin techo' };
}

function agentKeyOf(tenantId: string, alias: string): string {
  return `${tenantId}/${alias}`;
}

export function AssignmentMatrixPage() {
  const api = useApi();
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());

  const accounts = useMemo(() => readProviderAccounts(config.data), [config.data]);
  const agents = useMemo(() => readAgents(config.data), [config.data]);
  const ceiling = useMemo(() => readCeiling(config.data), [config.data]);
  const bindings = useMemo(() => readBindings(config.data), [config.data]);
  const tenantIds = useMemo(
    () => (config.data?.tenants ?? []).map((row) => row.id).filter((id): id is string => typeof id === 'string'),
    [config.data],
  );
  const context: RegistryContext = useMemo(() => ({
    accounts: accounts.items, agents: agents.items, ceiling: ceiling.items,
    bindings: bindings.items, tenantIds,
  }), [accounts.items, agents.items, ceiling.items, bindings.items, tenantIds]);
  const matrix = useMemo(
    () => buildAssignmentMatrix(agents.items, accounts.items, ceiling.items, bindings.items),
    [agents.items, accounts.items, ceiling.items, bindings.items],
  );
  const runner = useRegistryMutation({ config, access, context });

  const [assignment, setAssignment] = useState<Assignment>({
    agentKey: '', accountId: '', operation: 'grant-ceiling', priority: '100', enabled: true,
  });

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

  function selectCell(agentKey: string, accountId: string, cell: MatrixCell) {
    patch({
      agentKey,
      accountId,
      operation: cell.state === 'none' ? 'grant-ceiling'
        : cell.state === 'ceiling-only' ? 'create-binding' : 'update-binding',
      ...(cell.priority === null ? {} : { priority: String(cell.priority) }),
    });
  }

  const [selectedTenant, selectedAlias] = assignment.agentKey.split('/');
  // `Number('')` y `Number('   ')` valen 0, y 0 es una prioridad válida — además de la más alta.
  // Sin este guard, vaciar el campo no pedía un valor: despachaba `priority: 0` en silencio y el
  // alias pasaba a intentar esa cuenta primero. Un 0 escrito a propósito sigue siendo válido.
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

  if (config.loading && !config.data) return <LoadingState label="Leyendo techos y orden de fallback…" />;
  if (config.error && !config.data) return <ErrorState error={config.error} onRetry={config.reload} />;

  return <>
    <PageHeader
      eyebrow="Ruteo de cuentas"
      title="Matriz agente × cuenta"
      description="El techo (alias_routing_ceiling) es el conjunto exhaustivo de cuentas a las que un alias puede llegar a rutearse; el binding sólo ordena el fallback dentro de ese techo. Un binding no puede existir fuera del techo: referencia al techo, no a provider_accounts."
      actions={<RefreshButton onClick={config.reload} loading={config.loading} />}
    />
    <PermissionBadge access={access.data} permission="config.write" />

    <p className="notice" role="note">
      El intento 1 de cada delivery corre <strong>sin ningún override de entorno</strong>: el CLI resuelve la credencial que ya tiene logueada dentro de su container. Por eso el main del harness no es una fila de estas tablas y el orden de abajo describe únicamente los <strong>reintentos</strong>.
    </p>

    {missing.length ? <p className="notice error" role="alert">
      No disponible: este gateway no publica {missing.map((name) => <code key={name}>{name} </code>)}
      dentro de <code>GET /v3/console/config</code>. La matriz se muestra incompleta a propósito; la consola no rellena lo que el servidor no informa.
    </p> : null}

    <Panel title="Techo por alias" subtitle="Filas: agentes registrados. Columnas: cuentas visibles. Una celda sólo tiene estado si existe la fila de techo.">
      {!available && agents.items.length === 0
        ? <EmptyState>Sin datos de agentes para cruzar.</EmptyState>
        : matrix.length === 0
          ? <EmptyState>El servidor devolvió cero agentes registrados en <code>agents</code>. Un alias que hoy funciona por membresía puede no estar todavía en el registro: son dos cosas distintas.</EmptyState>
          : accounts.items.length === 0
            ? <EmptyState>No hay cuentas visibles para formar columnas.</EmptyState>
            : <div className="table-wrap">
              <table>
                <caption className="sr-only">Matriz de techo y fallback por agente y cuenta</caption>
                <thead><tr>
                  <th>Agente</th>
                  {accounts.items.map((account) => <th key={account.id}>
                    <span className="mono">{account.id}</span>
                    <div className="label-hint">{account.provider ?? 'UNKNOWN'} · paga {account.payerTenant ?? 'UNKNOWN'}</div>
                  </th>)}
                </tr></thead>
                <tbody>
                  {matrix.map((row) => {
                    const key = agentKeyOf(row.agent.tenantId, row.agent.alias);
                    return <tr key={key}>
                      <td><div className="identity-cell">
                        <span className="icon-box"><Cpu size={16} aria-hidden="true" /></span>
                        <div>
                          <strong>{row.agent.alias}</strong>
                          <div className="label-hint">{row.agent.tenantId} · harness {row.agent.harnessId ?? 'UNKNOWN'}</div>
                        </div>
                      </div></td>
                      {row.cells.map((cell) => {
                        const badge = cellBadge(cell);
                        return <td key={cell.accountId}>
                          <button
                            className="button small"
                            type="button"
                            aria-label={`${key} × ${cell.accountId}: ${badge.label}`}
                            onClick={() => selectCell(key, cell.accountId, cell)}
                          >
                            <Badge tone={badge.tone}>{badge.label}</Badge>
                          </button>
                          {cell.borrowed ? <div><span className="chip">prestada</span></div> : null}
                        </td>;
                      })}
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>}
    </Panel>

    <Panel title="Orden de fallback efectivo" subtitle="Sólo bindings habilitados y dentro del techo, de menor a mayor priority. Un techo sin binding habilitado es alcanzable pero nunca elegido.">
      {matrix.length === 0 ? <EmptyState>Sin agentes registrados.</EmptyState> : <ul className="config-records" aria-label="Orden de fallback por agente">
        {matrix.map((row) => <li key={agentKeyOf(row.agent.tenantId, row.agent.alias)}>
          <strong>{row.agent.tenantId}/{row.agent.alias}</strong>{' '}
          {row.fallback.length === 0
            ? <span className="unknown"><Ban size={13} aria-hidden="true" /> sin fallback: los reintentos corren igual que el intento 1</span>
            : <span className="chip-list">
              {row.fallback.map((step) => <span className="chip" key={step.accountId}>
                <ArrowDownUp size={12} aria-hidden="true" /> {step.rank}. {step.accountId} (prio {step.priority ?? 'UNKNOWN'}){step.borrowed ? ' · prestada' : ''}
              </span>)}
            </span>}
          {row.idleCeiling.length
            ? <div className="label-hint">En el techo pero sin binding habilitado: {row.idleCeiling.join(', ')}</div>
            : null}
        </li>)}
      </ul>}
    </Panel>

    <Panel title="Asignar" subtitle="Otorgar o revocar techo y ordenar el fallback. Todo pasa por el mismo POST /v3/console/config/changes con dry-run previo.">
      <div className="config-form">
        <label>Agente
          <select value={assignment.agentKey} onChange={(event) => patch({ agentKey: event.target.value })}>
            <option value="">— elegir —</option>
            {agents.items.map((agent) => {
              const key = agentKeyOf(agent.tenantId, agent.alias);
              return <option key={key} value={key}>{key}</option>;
            })}
          </select>
        </label>
        <label>Cuenta
          <select value={assignment.accountId} onChange={(event) => patch({ accountId: event.target.value })}>
            <option value="">— elegir —</option>
            {accounts.items.map((account) => <option key={account.id} value={account.id}>
              {account.id} · paga {account.payerTenant ?? 'UNKNOWN'}{account.sharedWithPool === true ? ' · en el pool' : ''}
            </option>)}
          </select>
        </label>
        <label className="config-json">Operación
          <select value={assignment.operation} onChange={(event) => patch({ operation: event.target.value as Operation })}>
            {(Object.keys(operationLabels) as Operation[]).map((operation) => <option key={operation} value={operation}>{operationLabels[operation]}</option>)}
          </select>
        </label>
        {needsPriority ? <label>Prioridad <span className="label-hint">0–32767, menor se intenta primero</span>
          <input value={assignment.priority} onChange={(event) => patch({ priority: event.target.value })} />
        </label> : null}
        {needsPriority ? <label><input type="checkbox" checked={assignment.enabled} onChange={(event) => patch({ enabled: event.target.checked })} /> Binding habilitado</label> : null}
      </div>
      {assignment.operation === 'revoke-ceiling' ? <p className="notice" role="note">
        <Link2Off size={14} aria-hidden="true" /> Revocar el techo borra en cascada el binding de ese alias hacia esa cuenta: la revocación no depende del orden en que se hagan las cosas.
      </p> : null}
      {assignment.operation === 'grant-ceiling' ? <p className="notice" role="note">
        <ShieldQuestion size={14} aria-hidden="true" /> Si la cuenta la paga otro tenant, sólo se puede otorgar cuando su pagador la publicó al pool. Ese consentimiento lo verifica Postgres, no la consola.
      </p> : null}
      <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="asignación" />
    </Panel>
  </>;
}
