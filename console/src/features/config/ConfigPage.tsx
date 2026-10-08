import './admin-ui.css';
import { Tabs } from '@base-ui/react/tabs';
import { ShieldOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConsoleAccess } from '../../api/types';
import { LinkButton, Notice } from '../../components/kit';
import { ErrorState, LoadingState, PageHeader, RefreshButton } from '../../components/ui';
import { cn } from '../../cn';
import type { permissionState } from '../../lib';
import {
  CONFIG_SIN_CONTROL_REASON, CONFIG_SIN_LECTURA_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON,
  onNavClick, useRouteSearch,
} from '../../router';
import { useMediaQuery } from '../../shell/use-media-query';
import { AccesoSection } from './AccesoSection';
import { AgentesSection } from './AgentesSection';
import { ArnesesSection } from './ArnesesSection';
import { AvanzadoSection } from './AvanzadoSection';
import { esNegativaDePermiso } from './config-change';
import { RemovalDialog } from './RemovalDialog';
import { TablasDeSeccion } from './ConfigTables';
import { EspaciosSection } from './EspaciosSection';
import { GeneralSection } from './GeneralSection';
import { CONFIG_SECTIONS, SECCION_POR_DEFECTO, type ConfigSectionId } from './sections';
import { useConfigWrites } from './use-config-writes';

/** Ajustes: a left sub-navigation of sections, one visible at a time. */
export function ConfigPage() {
  return <ConsoleAccessBoundary><ConfigPageContent /></ConsoleAccessBoundary>;
}

const NAV_TAB = 'cursor-pointer whitespace-nowrap rounded-md border-0 bg-transparent px-2.5 py-2 md:px-3 text-left text-[13px] font-medium text-fg-2 outline-none transition-colors '
  + 'hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand data-[active]:bg-muted-bg data-[active]:text-fg';

function seccionPedida(search: string): ConfigSectionId {
  const pedida = new URLSearchParams(search).get('seccion');
  return CONFIG_SECTIONS.find((section) => section.id === pedida)?.id ?? SECCION_POR_DEFECTO;
}

function ConfigPageContent() {
  const ctx = useConfigWrites();
  const { config } = ctx;
  const search = useRouteSearch();
  const [seccion, setSeccion] = useState<ConfigSectionId>(() => seccionPedida(search));
  const ancha = useMediaQuery('(min-width: 768px)');

  if (config.loading && !config.data) return <LoadingState label="Leyendo configuración versionada…" />;
  // A 403 is NOT a crash: the GET was refused for lack of `read`. See `esNegativaDePermiso` and `SinPermisoDeLectura`.
  if (config.error && !config.data) {
    return esNegativaDePermiso(config.error)
      ? <SinPermisoDeLectura detalle={config.error.message} />
      : <ErrorState error={config.error} onRetry={config.reload} />;
  }

  function irA(siguiente: ConfigSectionId) {
    setSeccion(siguiente);
    ctx.alCambiarDeSeccion();
  }

  const contenido: Record<ConfigSectionId, ReactNode> = {
    general: <GeneralSection ctx={ctx} onIr={irA} />,
    espacios: <EspaciosSection ctx={ctx} />,
    agentes: config.data ? <AgentesSection snapshot={config.data} onReload={() => { void config.reload(); }}
      tablaCompleta={<TablasDeSeccion ctx={ctx} seccion="agentes" />} /> : null,
    arneses: <ArnesesSection ctx={ctx} />,
    acceso: <AccesoSection ctx={ctx} />,
    avanzado: <AvanzadoSection ctx={ctx} />,
  };

  return <div className="grid gap-4">
    {ctx.removal ? <RemovalDialog key={JSON.stringify([ctx.removal.target, ctx.removal.kind])}
      target={ctx.removal.target} kind={ctx.removal.kind} revision={ctx.snapshotRevision}
      onClose={() => { ctx.setRemoval(undefined); }} reload={config.reload} /> : null}
    <PageHeader
      eyebrow="Configuración"
      title="Ajustes"
      description="Topología, agentes, permisos y cambios versionados. El contexto de cada agente se edita en su propia página."
      actions={<RefreshButton onClick={config.reload} loading={config.loading} compact />}
    />

    {/* Without permission, NOTHING is hidden: the tables look the same and the buttons stay inert with the
        reason written out. An absent panel does not distinguish "I don't have permission" from "this does not exist". */}
    <PermisoDeEscritura access={ctx.access.data} estado={ctx.estadoPermisoDeEscritura} />

    {/* `useResource` keeps the last good data when a reread fails: without this notice a failing GET went
        unnoticed, and the screen kept showing stale data with a fresh look. */}
    {config.error ? <Notice tone="danger" role="alert">
      La última relectura de la configuración falló ({config.error.message}): lo que ves es la
      ÚLTIMA lectura buena, no lo que el servidor tiene ahora.
    </Notice> : null}

    <Tabs.Root value={seccion} onValueChange={(valor) => { irA(valor as ConfigSectionId); }}
      orientation={ancha ? 'vertical' : 'horizontal'}
      className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[13rem_minmax(0,1fr)] md:items-start md:gap-6">
      <Tabs.List aria-label="Secciones de ajustes" activateOnFocus
        className={cn('flex gap-1 max-md:flex-wrap max-md:border-b max-md:border-line max-md:pb-2', 'md:sticky md:top-4 md:flex-col')}>
        {CONFIG_SECTIONS.map((section) => <Tabs.Tab key={section.id} value={section.id} className={NAV_TAB}>{section.label}</Tabs.Tab>)}
      </Tabs.List>
      {CONFIG_SECTIONS.map((section) => <Tabs.Panel key={section.id} value={section.id} keepMounted className="min-w-0 outline-none">
        {contenido[section.id]}
      </Tabs.Panel>)}
    </Tabs.Root>
  </div>;
}

/**
 * The write permission, stated in plain language.
 *
 * The raw identifier is NOT discarded: it is what you need to cite to request the permission from whoever
 * administers it. It goes after the sentence and on a secondary tier.
 *
 * `unknown` —the RBAC could not be attested— preserves reading and navigation but leaves each mutation
 * inert. The backend remains the authority; the UI must not use it as a substitute for a decision it could
 * not obtain.
 */
function PermisoDeEscritura({ access, estado }: {
  access?: ConsoleAccess;
  estado: ReturnType<typeof permissionState>;
}) {
  const texto = estado === 'allowed'
    ? 'Podés cambiar la configuración; todo cambio se deshace desde «Avanzado».'
    : estado === 'denied'
      // The EXACT wording from the sidebar (`CONFIG_SIN_CONTROL_REASON`): two wordings for the same denial would
      // lead the operator to believe they are two different problems.
      ? `Solo lectura: ${CONFIG_SIN_CONTROL_REASON} Los datos se muestran igual; lo que está apagado es todo lo que escribe.`
      : `Solo lectura: ${CONFIG_WRITE_NO_ACREDITADO_REASON}`;
  const roles = access?.roles?.length ? access.roles.join(', ') : 'UNKNOWN';
  return <Notice tone={estado === 'allowed' ? 'ok' : 'warn'} role="note" data-estado={estado}
    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <span>{texto}</span>
    <span className="font-mono text-xs opacity-80">RBAC config.write · roles {roles}</span>
  </Notice>;
}

/**
 * What someone arriving at `/config` via a bookmark without `read` permission sees.
 *
 * It names the READ permission, which is the one the refused GET requires; the sidebar's `control` wording
 * belongs to writing. There is no "Retry" button —repeating the request cannot grant a permission— but there
 * is a real exit to the homepage. The raw server message is shown too: it is what you need to cite to
 * request the permission.
 */
function SinPermisoDeLectura({ detalle }: { detalle: string }) {
  return (
    <div role="note" className="mx-auto grid max-w-xl justify-items-center gap-3 rounded-xl border border-line bg-surface p-8 text-center shadow-card">
      <ShieldOff aria-hidden="true" className="text-muted" />
      <strong>«Ajustes» necesita permiso de lectura</strong>
      <p className="m-0 text-[13px] text-fg-2">{CONFIG_SIN_LECTURA_REASON}</p>
      <p className="m-0 text-xs text-muted">
        El servidor contestó 403: <span className="font-mono">{detalle || 'sin mensaje'}</span>. Reintentar
        no cambia nada: falta el permiso, no se cayó Cauce.
      </p>
      <LinkButton href="/" onClick={(event) => { onNavClick(event, '/'); }}>Ir a la portada</LinkButton>
    </div>
  );
}
