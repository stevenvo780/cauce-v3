import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { Button, Notice, Pill, PREVIEW } from '../../components/kit';
import { HINT } from './config-ui';
import {
  buildAgentExtensionsMutation, catalogEntry, EXTENSION_CATALOG, extensionRisk, extensionSummary,
  readAgentExtensions, readHostAllowed, RISK_LABEL, RISK_TONE, sshPublicInfo, validateDraft,
  type AgentExtension, type ExtensionType,
} from './ampliaciones';
import { useSnapshotRunner } from './use-snapshot-runner';

const EMPTY_FIELDS: Record<string, string> = {};

function DraftFields({ type, fields, disabled, onChange }: {
  type: ExtensionType; fields: Partial<Record<string, string>>; disabled: boolean;
  onChange: (patch: Partial<Record<string, string>>) => void;
}) {
  const set = (key: string) => (event: { target: { value: string } }) => { onChange({ [key]: event.target.value }); };
  if (type === 'mount') return <div className="grid gap-3 sm:grid-cols-2">
    <label>Origen en el ordenador<input value={fields.source ?? ''} placeholder="/datos/ejemplo" disabled={disabled} onChange={set('source')} /></label>
    <label>Destino en el contenedor<input value={fields.target ?? ''} placeholder="/workspace/datos" disabled={disabled} onChange={set('target')} /></label>
    <label>Modo<select value={fields.mode ?? 'ro'} disabled={disabled} onChange={set('mode')}>
      <option value="ro">Solo lectura (ro)</option><option value="rw">Lectura y escritura (rw)</option></select></label>
  </div>;
  if (type === 'network') return <label>Nombre de la red Docker<input value={fields.name ?? ''} placeholder="red-existente" disabled={disabled} onChange={set('name')} /></label>;
  if (type === 'resources') return <div className="grid gap-3 sm:grid-cols-3">
    <label>Memoria<input value={fields.memory ?? ''} placeholder="2g" disabled={disabled} onChange={set('memory')} /></label>
    <label>CPU<input value={fields.cpus ?? ''} placeholder="1.5" disabled={disabled} onChange={set('cpus')} /></label>
    <label>Procesos (máx. 4096)<input type="number" min={1} max={4096} value={fields.pids ?? ''} disabled={disabled} onChange={set('pids')} /></label>
  </div>;
  if (type === 'ssh') return <label className="grid gap-1">Destinos (uno por línea, usuario@host[:puerto])
    <textarea rows={3} value={fields.hosts ?? ''} placeholder={'usuario@servidor.example.invalid:22'} disabled={disabled} onChange={set('hosts')} /></label>;
  if (type === 'docker') return <label>Acceso<select value={fields.access ?? 'read'} disabled={disabled} onChange={set('access')}>
    <option value="read">Solo lectura</option><option value="control">Control (equivale a root en el host)</option></select></label>;
  if (type === 'browser') return <div className="grid gap-3 sm:grid-cols-2">
    <label>Modo<select value={fields.mode ?? 'sidecar'} disabled={disabled} onChange={set('mode')}>
      <option value="sidecar">Chromium propio (sidecar)</option><option value="ssh_tunnel">Túnel SSH a navegador remoto</option></select></label>
    {(fields.mode ?? 'sidecar') === 'ssh_tunnel' ? <>
      <label>Host del navegador<input value={fields.host ?? ''} disabled={disabled} onChange={set('host')} /></label>
      <label>Puerto CDP<input type="number" min={1} max={65535} value={fields.port ?? ''} disabled={disabled} onChange={set('port')} /></label>
    </> : null}
  </div>;
  if (type === 'mcp') return <div className="grid gap-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label>Nombre<input value={fields.name ?? ''} disabled={disabled} onChange={set('name')} /></label>
      <label>Comando<input value={fields.command ?? ''} disabled={disabled} onChange={set('command')} /></label>
    </div>
    <label className="grid gap-1">Argumentos (uno por línea)<textarea rows={2} value={fields.args ?? ''} disabled={disabled} onChange={set('args')} /></label>
    <label className="grid gap-1">Variables de entorno (solo nombres, nunca valores)
      <textarea rows={2} value={fields.env ?? ''} placeholder="NOMBRE_DE_VARIABLE" disabled={disabled} onChange={set('env')} /></label>
  </div>;
  if (type === 'tools') return <label className="grid gap-1">Paquetes con versión fija (uno por línea)
    <textarea rows={3} value={fields.packages ?? ''} placeholder={'npm:paquete@1.2.3\npip:paquete==1.2.3'} disabled={disabled} onChange={set('packages')} /></label>;
  return null;
}

export function AmpliacionesTab({ tenantId, alias, snapshot, hostId, onReloaded, onDirtyChange }: {
  tenantId: string; alias: string; snapshot: ConfigurationSnapshot; hostId?: string | undefined;
  onReloaded: (snapshot: ConfigurationSnapshot) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { runner, current } = useSnapshotRunner(snapshot, onReloaded, `agent-extensions:${tenantId}/${alias}`);
  const { known, published } = readAgentExtensions(current, tenantId, alias);
  const row = current.agents?.find((item) => item.tenant_id === tenantId && item.alias === alias);
  const allowed = readHostAllowed(current, hostId);
  const [draft, setDraft] = useState<AgentExtension[] | undefined>();
  const [adding, setAdding] = useState<ExtensionType | undefined>();
  const [fields, setFields] = useState<Partial<Record<string, string>>>(EMPTY_FIELDS);
  const [formError, setFormError] = useState<string>();
  const [typedAlias, setTypedAlias] = useState('');
  const extensions = draft ?? known;
  const dirty = draft !== undefined;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  const hasFullControl = extensions.some((ext) => ext.type === 'full_control');
  const aliasOk = !hasFullControl || typedAlias === alias;
  const mutation: ConfigMutation | undefined = useMemo(
    () => (dirty ? buildAgentExtensionsMutation(tenantId, alias, extensions) : undefined),
    [dirty, tenantId, alias, extensions]);
  const disabled = !runner.canWrite || runner.busy;

  function edit(next: AgentExtension[]) { setDraft(next); runner.clear(); }
  function startAdd(type: ExtensionType) { setAdding(type); setFields({}); setFormError(undefined); runner.clear(); }
  function confirmAdd() {
    if (!adding) return;
    const result = validateDraft(adding, fields);
    if (!result.extension) { setFormError(result.error); return; }
    const ext = result.extension;
    const identity = ext.type === 'mount' ? `mount:${ext.target ?? ''}`
      : ext.type === 'network' || ext.type === 'mcp' ? `${ext.type}:${ext.name ?? ''}` : ext.type;
    const duplicate = extensions.some((item) => (item.type === 'mount' ? `mount:${item.target ?? ''}`
      : item.type === 'network' || item.type === 'mcp' ? `${item.type}:${item.name ?? ''}` : item.type) === identity);
    if (duplicate) { setFormError('Ya hay una ampliación de ese tipo o con ese destino. Quítala primero si quieres cambiarla.'); return; }
    if (ext.type === 'browser' && ext.mode === 'ssh_tunnel' && !extensions.some((item) => item.type === 'ssh')) {
      setFormError('El túnel SSH del navegador necesita la ampliación SSH: añádela primero.');
      return;
    }
    edit([...extensions, ext]);
    setAdding(undefined); setFields({}); setFormError(undefined);
  }

  return <div className="grid gap-4">
    <p className="m-0 text-[13px] leading-relaxed text-fg-2">
      Sin ampliaciones, el contenedor nace con el perfil más seguro: raíz de solo lectura, capacidades mínimas,
      una sola red y 128 procesos. Cada ampliación añade un permiso con nombre a este agente.
    </p>
    <Notice tone="warn" role="note">
      Cambiar las ampliaciones obliga a <strong>recrear el contenedor</strong> del agente (se detiene, se recrea
      conservando los volúmenes y se arranca). El cambio entra como operación de flota con vista previa.
    </Notice>
    {!published ? <Notice tone="info" role="note">
      El servidor aún no publica las ampliaciones de este agente en esta lectura. Puedes preparar el borrador;
      la vista previa la aceptará el gateway cuando la mutación <code>agent_extensions</code> esté disponible.
    </Notice> : null}
    {allowed.published && hostId ? <p className={HINT}>
      El ordenador admite: {allowed.allowed.types.length ? allowed.allowed.types.join(', ') : 'ningún tipo por ahora'}.
      Lo que el ordenador no admite, la vista previa lo rechaza con el motivo.
    </p> : hostId ? <p className={HINT}>El ordenador aún no publica qué ampliaciones admite; la vista previa del servidor lo decide.</p> : null}

    <section aria-label={`Ampliaciones de ${tenantId}/${alias}`} className="grid gap-2">
      <h3 className="m-0 text-sm font-semibold">Ampliaciones activas ({extensions.length})</h3>
      {extensions.length ? <ul className="m-0 grid list-none gap-2 p-0">
        {extensions.map((ext, index) => {
          const entry = catalogEntry(ext.type);
          const risk = extensionRisk(ext);
          const ssh = ext.type === 'ssh' ? sshPublicInfo(ext, row) : undefined;
          return <li key={`${ext.type}-${String(index)}`} className="grid gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[13px]">{entry.label}</strong>
              <Pill tone={RISK_TONE[risk]}>{risk === 'maximo' ? 'Máximo' : RISK_LABEL[risk]}</Pill>
              <span className="min-w-0 flex-1 text-xs break-words text-muted">{extensionSummary(ext)}</span>
              <Button size="sm" variant="danger" disabled={disabled} aria-label={`Quitar ampliación ${entry.label}`}
                onClick={() => { edit(extensions.filter((_, item) => item !== index)); }}>
                <Trash2 size={12} aria-hidden="true" />Quitar</Button>
            </div>
            <p className="m-0 text-xs text-fg-2">{entry.allows}.</p>
            {ssh ? <div className="grid gap-1 rounded-md bg-subtle px-2.5 py-2 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium"><KeyRound size={12} aria-hidden="true" />Clave pública SSH</span>
              {ssh.publicKey ? <>
                <code className="block break-all whitespace-pre-wrap">{ssh.publicKey}</code>
                {ssh.fingerprint ? <span>Huella: <code className="break-all">{ssh.fingerprint}</code></span> : null}
                <span className="text-muted">Añade la clave pública al <code>authorized_keys</code> del destino. La privada nunca sale del volumen de perfil.</span>
              </> : <span className="text-muted">La clave pública y su huella aparecerán aquí cuando <code>prepare</code> genere la clave en el volumen de perfil.</span>}
            </div> : null}
          </li>;
        })}
      </ul> : <p className="m-0 text-[13px] text-muted">Este agente no tiene ampliaciones: su contenedor queda exactamente con el perfil seguro por defecto.</p>}
    </section>

    <section aria-label="Añadir ampliación" className="grid gap-3 rounded-lg border border-line bg-subtle p-3">
      <h3 className="m-0 text-sm font-semibold">Añadir desde el catálogo</h3>
      <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
        {EXTENSION_CATALOG.map((entry) => <li key={entry.type} className="grid gap-1 rounded-lg border border-line bg-surface px-3 py-2.5">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="text-[13px]">{entry.label}</strong>
            <Pill tone={entry.tone}>{entry.riskLabel}</Pill>
          </span>
          <span className="text-xs leading-relaxed text-fg-2">{entry.allows}.</span>
          <span><Button size="sm" disabled={disabled || adding === entry.type} aria-label={`Añadir ampliación ${entry.label}`}
            onClick={() => { startAdd(entry.type); }}><Plus size={12} aria-hidden="true" />Añadir</Button></span>
        </li>)}
      </ul>
      {adding ? <div className="grid gap-3 rounded-lg border border-line bg-surface p-3" aria-label={`Formulario de ${catalogEntry(adding).label}`}>
        <h4 className="m-0 text-[13px] font-semibold">{catalogEntry(adding).label} · {catalogEntry(adding).riskLabel}</h4>
        <DraftFields type={adding} fields={fields} disabled={disabled}
          onChange={(patch) => { setFields((previous) => ({ ...previous, ...patch })); runner.clear(); }} />
        {adding === 'full_control' ? <Notice tone="danger" role="alert">
          Control total: raíz escribible y sin cap-drop. Solo para agentes de infraestructura.
        </Notice> : null}
        {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={disabled} onClick={confirmAdd}>Añadir al borrador</Button>
          <Button size="sm" disabled={disabled} onClick={() => { setAdding(undefined); setFormError(undefined); }}>Cancelar</Button>
        </div>
      </div> : null}
    </section>

    {hasFullControl ? <label className="grid gap-1 text-[13px]">Escribe el alias <code>{alias}</code> para confirmar el control total
      <input value={typedAlias} autoComplete="off" disabled={disabled}
        onChange={(event) => { setTypedAlias(event.target.value); runner.clear(); }} /></label> : null}
    {!aliasOk ? <p className={HINT}>Escribe exactamente el alias para habilitar la vista previa con control total.</p> : null}

    {runner.notice ? <Notice role={runner.notice.tone === 'error' ? 'alert' : 'status'}
      tone={runner.notice.tone === 'error' ? 'danger' : 'info'}>{runner.notice.text}</Notice> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
      <div className="flex flex-wrap gap-2">
        {dirty ? <Button disabled={disabled} onClick={() => { setDraft(undefined); setTypedAlias(''); runner.clear(); }}>Descartar borrador</Button> : null}
        <Button disabled={disabled || !mutation || !aliasOk}
          onClick={() => { if (mutation) void runner.run(mutation, true); }}>Vista previa</Button>
        <Button variant="primary" disabled={disabled || !mutation || !aliasOk || !runner.isValidated(mutation)}
          onClick={() => { if (mutation) void runner.run(mutation, false); }}>Aplicar y recrear</Button>
      </div>
    </div>
    {!runner.canWrite ? <Notice role="note">Edición de ampliaciones en solo lectura: falta permiso acreditado de configuración.</Notice> : null}
    {runner.preview ? <pre className={PREVIEW} aria-label="Vista previa de ampliaciones">{runner.preview}</pre> : null}
    <p className={HINT}>Quitar una ampliación también recrea el contenedor al aplicar.</p>
  </div>;
}
