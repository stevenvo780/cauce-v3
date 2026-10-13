import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SpaceBackup, SpaceBackupTarget } from '../../api/client/space-backups-client';
import { ApiError } from '../../api/client/core';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';
import { randomUuid } from '../../random-id';
import { CompanySession } from '../auth/company-authority';
import { sessionAuthority } from '../auth/auth-session';
import { canBackupSpace } from './space-backup-authority';

const STATUS = { pending: 'Backup pendiente', running: 'Preparando backup', ready: 'Backup disponible', failed: 'El backup falló' };
const ERRORS = { HOST_UNAVAILABLE: 'El ordenador no está disponible. Recupera su conexión antes de crear otro backup.',
  SCOPE_CHANGED: 'El espacio o su autorización cambiaron. Relee el agente antes de crear otro backup.',
  EXPORT_FAILED: 'No se pudo exportar el espacio. Revisa su estado y vuelve a intentarlo.',
  LIMIT_EXCEEDED: 'El espacio supera el límite de tamaño del backup. No se creó una copia incompleta.',
  EXPIRED: 'El backup venció. Crea uno nuevo para descargarlo.' };
const REQUEST_MS = 30_000;
const FAILURES: Record<number, string> = {
  404: 'No se encontró el agente, su ubicación o el backup. Relee el agente: puede haberse movido o retirado.',
  409: 'No se pudo crear el backup ahora: el ordenador del espacio no tiene ejecutor disponible, se alcanzó el límite de copias o de espacio reservado, o cambió la política. Libera copias o recupera el ordenador y vuelve a intentarlo.',
};
export function SpaceBackupPanel({ tenantId, alias }: { tenantId: string; alias: string }) {
  const state = useContext(CompanySession); const authority = sessionAuthority(state);
  const target = { company_id: authority?.acting_company ?? '', tenant_id: tenantId, alias };
  const allowed = canBackupSpace(state, tenantId);
  return <BackupPanel key={JSON.stringify([target, authority?.role, allowed])} target={target} allowed={allowed} />;
}
function BackupPanel({ target, allowed }: { target: SpaceBackupTarget; allowed: boolean }) {
  const api = useApi();
  const [backup, setBackup] = useState<SpaceBackup>();
  const [busy, setBusy] = useState<'creating' | 'reading'>();
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [invalidated, setInvalidated] = useState(false);
  const permitted = useRef(allowed && !invalidated); permitted.current = allowed && !invalidated;
  const active = useRef(true); const generation = useRef(0); const requests = useRef(new Set<AbortController>());
  const idempotency = useRef(randomUuid()); const locked = useRef(false);
  const enabled = allowed && !invalidated;
  const requestIsCurrent = useCallback((request: AbortController, started: number) => active.current && permitted.current
    && started === generation.current && !request.signal.aborted, []);
  useLayoutEffect(() => {
    active.current = true;
    const clear = () => {
      generation.current += 1; for (const request of requests.current) request.abort(); requests.current.clear();
    };
    const changed = api.onAuthGenerationChange(() => {
      permitted.current = false;
      clear(); idempotency.current = randomUuid(); locked.current = false; setBackup(undefined); setBusy(undefined); setNotice('');
      setError('La sesión o empresa cambió. Relee el agente antes de descargar.'); setInvalidated(true);
    });
    const session = api.onAuthSession(state => {
      if (sessionAuthority(state)?.acting_company === target.company_id && canBackupSpace(state, target.tenant_id)) {
        setInvalidated(false); setError('');
      }
    });
    return () => { active.current = false; changed(); session(); clear(); };
  }, [api, target.company_id, target.tenant_id]);
  const perform = useCallback(async (kind: 'creating' | 'reading', action: (signal: AbortSignal) => Promise<SpaceBackup>, background = false) => {
    if (!enabled || !permitted.current || locked.current && !background) return;
    const request = new AbortController(); const started = generation.current; requests.current.add(request);
    // Not AbortSignal.any: Safari before 17.4 lacks it. The timeout shares the controller, so both end the request.
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, REQUEST_MS);
    if (!background) { locked.current = true; setBusy(kind); setError(''); setNotice(''); }
    try {
      const value = await action(request.signal);
      if (!requestIsCurrent(request, started)) return;
      setBackup(value);
    } catch (cause) {
      if (!active.current || started !== generation.current || request.signal.aborted && !timedOut) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) { permitted.current = false; setBackup(undefined); setInvalidated(true); }
      setError((cause instanceof ApiError ? FAILURES[cause.status] : undefined) ?? 'No se pudo leer o preparar el backup. Actualiza su estado y comprueba tus permisos.');
    } finally {
      window.clearTimeout(timeout);
      requests.current.delete(request);
      if (active.current && started === generation.current && !background) { locked.current = false; setBusy(undefined); }
    }
  }, [enabled, requestIsCurrent]);
  const download = (ready: SpaceBackup) => {
    if (!enabled) return;
    try {
      const link = document.createElement('a'); link.href = api.spaceBackupDownloadUrl(ready);
      link.download = `space-${target.alias.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64)}-${ready.id}.zip`;
      link.hidden = true; document.body.append(link); link.click(); link.remove();
      setError(''); setNotice('Descarga iniciada en el navegador: si no aparece, la copia pudo vencer o no tienes permiso; vuelve a generarla.');
    } catch { setError('No se pudo preparar la descarga. Relee el estado del backup antes de reintentar.'); }
  };
  const refresh = () => { if (backup) void perform('reading', signal => api.getSpaceBackup(target, backup.id, signal)); };
  useEffect(() => {
    if (!enabled || !backup || !['pending', 'running'].includes(backup.status) || busy) return;
    const timer = setTimeout(() => { void perform('reading', signal => api.getSpaceBackup(target, backup.id, signal), true); }, 1500);
    return () => { clearTimeout(timer); };
  }, [api, backup, enabled, busy, perform, target]);
  return <section aria-label="Backup del espacio" className="my-4 grid gap-3 rounded-xl border border-line bg-surface p-4">
    <div><h3 className="m-0 text-base font-semibold">Backup del espacio</h3>
      <p className="m-0 mt-1 text-sm text-muted">Guarda contexto, directivas, proyectos, configuración y datos del espacio. El archivo excluye autenticación, credenciales, logs y temporales.</p>
      <p className="m-0 mt-1 text-sm text-muted">Los proyectos se copian sin <code>.git</code>: los commits sin publicar no viajan. Los archivos <code>.env</code> y de credenciales se omiten.</p></div>
    {!enabled ? <Notice tone="warn">Hace falta autoridad vigente para controlar este espacio y descargar su backup.</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {backup ? <div className="grid gap-1"><p className="m-0 text-sm" role="status">{STATUS[backup.status]}</p>
      {backup.error ? <Notice tone="danger" role="alert">{ERRORS[backup.error]}</Notice> : null}
      {backup.status === 'ready' ? <p className="m-0 text-xs text-muted">{((backup.bytes ?? 0) / 1024 / 1024).toFixed(2)} MiB · ZIP listo para descargar; el navegador lo guarda sin cargarlo en memoria.</p> : null}
      {backup.status === 'ready' && backup.sha256 ? <p className="m-0 break-all text-xs text-muted">SHA-256: <code>{backup.sha256}</code></p> : null}
      {backup.status === 'ready' && backup.sha256 ? <p className="m-0 text-xs text-muted">Para comparar el SHA-256, ejecuta <code>sha256sum archivo.zip</code> sobre el archivo descargado y verifica que coincida con el valor de arriba.</p> : null}</div> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!enabled || !!busy || backup?.status === 'pending' || backup?.status === 'running'} onClick={() => {
        if (backup) idempotency.current = randomUuid(); setBackup(undefined);
        void perform('creating', signal => api.createSpaceBackup(target, idempotency.current, signal));
      }}>{busy === 'creating' ? 'Solicitando backup…' : backup ? 'Crear otro backup' : 'Crear backup del espacio'}</Button>
      {backup ? <Button disabled={!enabled || !!busy} onClick={refresh}>{busy === 'reading' ? 'Actualizando…' : 'Actualizar estado del backup'}</Button> : null}
      {backup?.status === 'ready' ? <Button variant="primary" disabled={!enabled || !!busy} onClick={() => {
        download(backup);
      }}>Descargar backup ZIP</Button> : null}
    </div>
  </section>;
}
