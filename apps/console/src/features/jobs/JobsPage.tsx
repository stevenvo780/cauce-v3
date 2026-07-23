import { Box, Play, Zap } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/context';
import type { JobLane } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId, permissionState, safeJobLane, safeJobState } from '../../lib';

export function JobsPage() {
  const api = useApi();
  const resource = useResource('jobs', () => api.listJobs());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [lane, setLane] = useState<JobLane>('interactive');
  const [kind, setKind] = useState('system.database.probe');
  const [payload, setPayload] = useState('{}');
  const [priority, setPriority] = useState(10);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const items = resource.data?.items ?? [];
  const canCreate = permissionState(access.data, 'job.create') === 'allowed';
  const grouped = {
    interactive: items.filter((job) => safeJobLane(job.lane) === 'interactive'),
    batch: items.filter((job) => safeJobLane(job.lane) === 'batch'),
    unknown: items.filter((job) => safeJobLane(job.lane) === undefined),
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) {
      setError('Creación bloqueada: permiso RBAC DENY o UNKNOWN.');
      return;
    }
    setError(undefined);
    setNotice(undefined);
    let decoded: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(payload);
      if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') throw new Error('El payload debe ser un objeto JSON.');
      decoded = candidate as Record<string, unknown>;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'JSON inválido');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createJob({ lane, priority, kind: kind.trim(), payload: decoded });
      setNotice(`Job creado: ${compactId(result.job_id)}`);
      resource.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error desconocido');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Fair scheduler" title="Jobs interactive & batch" description="Dos lanes visibles sin simular ejecución en el navegador. La prioridad y el claim efectivo pertenecen al dispatcher." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="job.create" />
      <Panel title="Enqueue job" subtitle="Cauce valida tenant y permisos desde la sesión HttpOnly.">
        <form className="job-form" onSubmit={(event) => void submit(event)}>
          <label>Lane<select value={lane} onChange={(event) => setLane(event.target.value as JobLane)}><option value="interactive">Interactive</option><option value="batch">Batch</option></select></label>
          <label>Kind<input value={kind} onChange={(event) => setKind(event.target.value)} required maxLength={80} /></label>
          <label>Prioridad<input type="number" value={priority} onChange={(event) => setPriority(event.target.valueAsNumber)} min={-100} max={100} required /></label>
          <label className="job-payload">Payload JSON<textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows={5} spellCheck={false} /></label>
          <button className="button primary" type="submit" disabled={!canCreate || submitting}><Play size={16} aria-hidden="true" />{submitting ? 'Encolando…' : 'Encolar'}</button>
        </form>
        {notice ? <p className="notice success" role="status">{notice}</p> : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
      </Panel>
      {resource.loading && !resource.data ? <LoadingState /> : null}
      {resource.error && !resource.data ? <ErrorState error={resource.error} onRetry={resource.reload} /> : null}
      {resource.data ? (
        <div className="lane-grid">
          {(['interactive', 'batch'] as const).map((laneName) => (
            <Panel key={laneName} title={laneName === 'interactive' ? 'Interactive lane' : 'Batch lane'} subtitle={laneName === 'interactive' ? 'Baja latencia, burst limitado' : 'Fairness garantizada mientras espera'}>
              <div className={`lane-title-icon ${laneName}`} aria-hidden="true">{laneName === 'interactive' ? <Zap /> : <Box />}</div>
              {grouped[laneName].length === 0 ? <EmptyState>Sin jobs en esta lane.</EmptyState> : (
                <ul className="job-list">
                   {grouped[laneName].map((job, index) => {
                     const status = safeJobState(job.status);
                     return <li key={job.job_id ?? index}>
                      <div><strong><Unknown value={job.kind} /></strong><span className="mono">{compactId(job.job_id)}</span></div>
                       <Badge tone={status === 'done' ? 'done' : status === 'failed' || status === 'dead' ? 'danger' : status === 'running' ? 'running' : status === 'queued' ? 'warning' : 'unknown'}><Unknown value={status} /></Badge>
                      <dl><div><dt>Prioridad</dt><dd><Unknown value={job.priority} /></dd></div><div><dt>Intentos</dt><dd><Unknown value={job.attempts} /></dd></div><div><dt>Claimed by</dt><dd><Unknown value={job.claimed_by} /></dd></div><div><dt>Creado</dt><dd><Time value={job.created_at} /></dd></div></dl>
                     </li>;
                   })}
                </ul>
              )}
            </Panel>
          ))}
          {grouped.unknown.length ? <Panel title="Lane UNKNOWN"><p>{grouped.unknown.length} jobs sin lane confiable.</p></Panel> : null}
        </div>
      ) : null}
    </>
  );
}
