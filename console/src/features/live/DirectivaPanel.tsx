import { ArrowRight, BookOpen, Brain, IdCard } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';
import { cn } from '../../cn';
import { Button, Notice } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { selectAgentRegistryEntry } from './agent-registry-entry';
import { ubicacionDeclarada } from './capas-pendientes';
import { AvisosDeSolapamiento } from './capas/AvisosDeSolapamiento';
import { CapaCard } from './capas/CapaCard';
import { CapasPendientes } from './capas/CapasPendientes';
import { CapaDeFicheros, CapaDeMemoria } from './capas/ContenidoDeCapas';
import { avisosDeCapas } from './directiva';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

interface DirectivaPanelProps {
  tenantId: string;
  alias: string;
  /** The versioned read the page already holds: warning with revision A and showing B is the bug to avoid. */
  configuration: Resource<ConfigurationSnapshot>;
  onEditProfile: () => void;
  onEditManual: () => void;
}

/** The three layers that govern an agent, side by side and read-only: role, site manual and memory. */
export function DirectivaPanel({ tenantId, alias, configuration, onEditProfile, onEditManual }: DirectivaPanelProps) {
  const api = useApi();
  const directive = useResource(`directiva-ficheros-${tenantId}-${alias}`, () => api.getAgentDirective(tenantId, alias));
  const entry = selectAgentRegistryEntry(configuration.data, tenantId, alias);
  const warnings = avisosDeCapas(entry.state === 'found' ? entry.roleBrief : undefined, directive.error ? undefined : directive.data);
  return (
    <div className="grid gap-4">
      <AvisosDeSolapamiento avisos={warnings} />
      <CapaCard
        icono={<IdCard size={15} />} numero={1} titulo="Rol declarado" fin="QUIÉN SOS y QUÉ PODÉS DECIDIR"
        fuente="agent_profiles.role_summary · role_brief es sólo su proyección"
        porque={'Es la única capa que sigue siendo verdad si se recrea el contenedor o cambia el arnés, así que es la única '
          + 'que debe fijar identidad, límites de autonomía y a quién se escala.'}
        actions={<Button variant="primary" size="sm" onClick={onEditProfile}>
          Editar los campos canónicos <ArrowRight size={14} aria-hidden="true" />
        </Button>}
      >
        <RoleProjection tenantId={tenantId} alias={alias} configuration={configuration} />
      </CapaCard>
      <CapaCard
        icono={<BookOpen size={15} />} numero={2} titulo="Manual del sitio" fin="CÓMO SE TRABAJA AQUÍ"
        fuente="CLAUDE.md / AGENTS.md dentro del runtime · no es inventario de configuración ni memoria"
        porque={'Rutas, comandos, convenciones, qué no tocar, cómo se despliega. No repite identidad ni autonomía: '
          + 'si empieza con «Sos…», está invadiendo la capa 1.'}
        actions={<Button size="sm" onClick={onEditManual}>Editar el manual en Ficheros</Button>}
      >
        <CapaDeFicheros recurso={directive} />
      </CapaCard>
      <CapaCard
        icono={<Brain size={15} />} numero={3} titulo="Memoria" fin="LO QUE ESE AGENTE APRENDIÓ"
        fuente="~/.claude/projects · ~/.openclaw/memory · sólo lectura"
        porque={'Hechos que midió él mismo. Ni identidad ni manual. Desde acá se lee el índice: el contenido se edita '
          + 'donde se escribió, no desde la consola.'}
      >
        <CapaDeMemoria recurso={directive} />
      </CapaCard>
      <CapasPendientes ubicacion={ubicacionDeclarada(configuration.data, tenantId, alias)} alias={alias} />
    </div>
  );
}

/**
 * The legacy `agents.role_brief` projection. A failed read, a gateway without the registry and an
 * alias with no row are three different facts, and none of them is an empty role.
 */
function RoleProjection({ tenantId, alias, configuration }: Pick<DirectivaPanelProps, 'tenantId' | 'alias' | 'configuration'>) {
  const entry = selectAgentRegistryEntry(configuration.data, tenantId, alias);
  if (configuration.loading && !configuration.data) {
    return <p className="m-0 text-muted">Leyendo la proyección del rol desde el registro…</p>;
  }
  if (configuration.error && !configuration.data) {
    return <EmptyState>No se pudo leer la proyección del rol; no se interpreta como un rol vacío: {configuration.error.message}</EmptyState>;
  }
  if (entry.state === 'registry-unavailable') {
    return <EmptyState>Este gateway no publica el registro de agentes, así que no hay una proyección del rol que mostrar.</EmptyState>;
  }
  if (entry.state === 'agent-missing') {
    return <EmptyState>{alias} no está en el registro de agentes de {tenantId}. Un alias sin fila no tiene una proyección declarada que mostrar.</EmptyState>;
  }
  const length = contarRoleBrief(entry.roleBrief);
  const tone = tonoRoleBrief(length);
  return (
    <div className="grid gap-2">
      {configuration.error ? (
        <Notice tone="danger" role="alert">
          La última relectura falló ({configuration.error.message}); se muestra la última lectura buena.
        </Notice>
      ) : null}
      <label>
        <span className="text-xs font-normal text-muted">Proyección legacy del rol · solo lectura: se edita en los campos canónicos</span>
        <textarea aria-label={`Proyección del rol de ${alias}`} rows={6} value={entry.roleBrief} readOnly spellCheck={false} />
      </label>
      <span data-tone={tone} className={cn('text-right text-xs tabular-nums', tone === 'ok' ? 'text-muted' : tone === 'cerca' ? 'text-warn-ink' : 'font-medium text-danger-ink')}>
        {length} / {ROLE_BRIEF_MAX}
      </span>
    </div>
  );
}
