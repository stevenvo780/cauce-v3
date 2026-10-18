import { Braces, RotateCcw, Save, SearchCheck } from 'lucide-react';
import { ActionButton } from '../../components/action-button';
import { CARD_TABLE, Notice, Outcome, PREVIEW, SCROLL, SectionCard } from '../../components/kit';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { onNavClick } from '../../router';
import { FORM_GRID } from './config-ui';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import { RecentFleetOperations } from './RecentFleetOperations';
import { actionsFor, mutationResourceReason, PLATFORM_CLI_REASON, rollbackPolicy, templates } from './mutation-editor';
import type { ConfigWrites } from './use-config-writes';
import type { ConfigResource, ConfigAction } from '../../api/types';

/** The audit trail with rollback, the raw mutation editor and every collection the console cannot present. */
export function AvanzadoSection({ ctx }: { ctx: ConfigWrites }) {
  const { config, canalRollback, canalEditor, soloLectura, busy } = ctx;
  const revisions = config.data?.revisions;
  const chainReason = mutationResourceReason('chain_policy', config.data);
  let editorReason = mutationResourceReason(ctx.resource, config.data);
  try {
    const mutation: unknown = JSON.parse(ctx.editor);
    if (mutation && typeof mutation === 'object' && 'resource' in mutation && typeof mutation.resource === 'string') {
      editorReason = mutationResourceReason(mutation.resource, config.data);
    }
  } catch { /* Invalid JSON is reported by the existing submit path. */ }
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="avanzado" />

    <SectionCard level={3} title="Historial de revisiones" description="Rollback crea una nueva revisión; el historial nunca se reescribe.">
      {/* The `oldValue` the store keeps as the inverse is the WHOLE ROW that was there before, not the field that was
          touched, even if the mutation that was sent was partial. The operator cannot deduce that from a button labeled
          "Rollback", and the difference could cost them a teammate's change. */}
      <Notice role="note">
        Deshacer restituye la FILA COMPLETA que había antes de esa revisión, no sólo el campo que se
        tocó: si otro operador cambió otro campo de la misma fila después, ese cambio también se
        revierte.
      </Notice>

      {/* The rollback outcome is painted HERE, above the table and in plain sight: it is the only spot the operator
          is looking at when they press one of these buttons. */}
      {canalRollback.notice ? <Outcome tone={canalRollback.notice.tone} canal={canalRollback.canal}>{canalRollback.notice.text}</Outcome> : null}
      {canalRollback.preview ? <pre className={PREVIEW} aria-label="Preview del rollback">{canalRollback.preview}</pre> : null}

      {!revisions?.length ? <EmptyState>No hay revisiones.</EmptyState> : <Desplazable etiqueta="Historial de revisiones de configuración" className={SCROLL}>
        <table className={CARD_TABLE}><thead><tr><th>Rev</th><th>Actor</th><th>Resumen</th><th>Fecha</th><th>Rollback</th></tr></thead><tbody>
          {revisions.map((revision, index) => {
            const policy = rollbackPolicy(revision.operation, config.data);
            const id = revision.id;
            return <tr key={id ?? index}>
              <td data-label="Rev"><Badge tone="info"><Unknown value={id} /></Badge></td>
              <td data-label="Actor"><Unknown value={`${revision.actor_tenant ?? 'UNKNOWN'}:${revision.actor_alias ?? 'UNKNOWN'}`} /></td>
              <td data-label="Resumen"><Unknown value={revision.summary} /></td>
              <td data-label="Fecha"><Time value={revision.created_at} /></td>
              <td data-label="Rollback">{id && policy.allowed
                ? <span className="inline-flex gap-1.5">
                  <ActionButton size="sm" label="Preview" pendingLabel="Previsualizando…" done={false} announceError={false} disabled={soloLectura || busy} action={() => ctx.rollback(id, revision.operation, true)} />
                  <ActionButton size="sm" label="Rollback" pendingLabel="Revirtiendo…" done={false} announceError={false} disabled={soloLectura || busy} icon={<RotateCcw size={14} aria-hidden="true" />} action={() => ctx.rollback(id, revision.operation, false)} />
                </span>
                : id && !policy.allowed
                  ? <span className="text-xs text-muted">{policy.message}{policy.accountResource ? <> <a href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Abrir Cuentas</a>.</> : null}</span>
                  : <Unknown value={null} />}</td>
            </tr>;
          })}
        </tbody></table>
      </Desplazable>}
    </SectionCard>

    {/* The escape hatch remains for resources without forms. Account registry mutations are rejected here because
        their sole authority is /accounts; `agent` remains available, except for its read-only role_brief projection. */}
    <details className="group rounded-xl border border-line bg-surface shadow-card">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">
        <Braces size={14} aria-hidden="true" /> Editor de mutaciones JSON — válvula de escape para lo que no tiene formulario
      </summary>
      <section className="grid gap-3 border-t border-line p-4">
        <h3 className="m-0 text-sm font-semibold">Editor de mutaciones</h3>
        <Notice role="note">{PLATFORM_CLI_REASON}</Notice>
        {chainReason ? <Notice role="note">Política de cadena: {chainReason}</Notice> : null}
        {editorReason ? <Notice role="note">{editorReason}</Notice> : null}
        <p className="m-0 text-xs text-muted">Revisión esperada: {String(canalEditor.expectedRevision ?? 'UNKNOWN')}</p>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); }}>
          <div className={FORM_GRID}>
            <label>Resource<select disabled={soloLectura || busy} value={ctx.resource} onChange={(event) => { ctx.selectTemplate(event.target.value as ConfigResource, ctx.action); }}>{Object.keys(templates).map((item) => <option key={item} disabled={Boolean(mutationResourceReason(item, config.data))}>{item}</option>)}</select></label>
            <label>Action<select disabled={soloLectura || busy} value={ctx.action} onChange={(event) => { ctx.selectTemplate(ctx.resource, event.target.value as ConfigAction); }}>{actionsFor(ctx.resource).map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <label>Mutación JSON<textarea aria-label="Mutación JSON" className="font-mono text-xs" disabled={soloLectura || busy} rows={12} value={ctx.editor} onChange={(event) => { ctx.editarMutacion(event.target.value); }} spellCheck={false} /></label>
          <div className="flex flex-wrap gap-2">
            <ActionButton label="Preview / dry-run" pendingLabel="Previsualizando…" done={false} announceError={false} disabled={soloLectura || busy || Boolean(editorReason)} icon={<SearchCheck size={16} aria-hidden="true" />} action={(event) => ctx.submit(event, true)} />
            <ActionButton variant="primary" label="Aplicar atómico" pendingLabel="Aplicando…" done={false} announceError={false} disabled={soloLectura || busy || Boolean(editorReason)} icon={<Save size={16} aria-hidden="true" />} action={(event) => ctx.submit(event, false)} />
          </div>
        </form>
        {canalEditor.preview ? <pre className={PREVIEW} aria-label="Resultado de preview">{canalEditor.preview}</pre> : null}
        {canalEditor.notice ? <Outcome tone={canalEditor.notice.tone} canal={canalEditor.canal}>{canalEditor.notice.text}</Outcome> : null}
      </section>
    </details>

    <RecentFleetOperations />

    <TablasDeSeccion ctx={ctx} seccion="avanzado" />
  </div>;
}
