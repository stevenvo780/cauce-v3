import { Wrench } from 'lucide-react';
import { type SyntheticEvent, useRef, useState } from 'react';
import { useApi } from '../../../api/context';
import type { AgentDocumentsMap } from '../../../api/types';
import { useResource } from '../../../api/use-resource';
import {
  ROADMAP_DE_CAPAS, contrasteDeUbicacion, ubicacionMedida,
  type ContrasteDeUbicacion, type UbicacionDeclarada,
} from '../capas-pendientes';

function Dato({ contraste, midiendo }: { contraste: ContrasteDeUbicacion; midiendo?: boolean }) {
  if (contraste.estado === 'medido') return <code>{contraste.valor}</code>;
  const faltante = midiendo === true
    ? <span className="muted">midiendo…</span>
    : <span className="unknown">desconocido</span>;
  if (contraste.estado === 'desconocido' && contraste.declarado === undefined) return faltante;
  return (
    <>
      declarado <code>{contraste.declarado}</code> · medido{' '}
      {contraste.estado === 'discrepa' ? <code>{contraste.medido}</code> : faltante}
    </>
  );
}

export function CapasPendientes({ ubicacion, alias }: { ubicacion: UbicacionDeclarada; alias: string }) {
  const api = useApi();
  const [abierto, setAbierto] = useState(false);
  const abiertoRef = useRef(false);
  const documentos = useResource<AgentDocumentsMap | undefined>(
    `ubicacion-medida-${ubicacion.tenantId}-${ubicacion.alias}`,
    () => (abiertoRef.current
      ? api.getAgentDocuments(ubicacion.tenantId, ubicacion.alias)
      : Promise.resolve(undefined)),
  );
  const medida = ubicacionMedida(documentos.error ? undefined : documentos.data);
  const midiendo = abierto && documentos.loading && documentos.data === undefined;
  const alDesplegar = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || abiertoRef.current) return;
    abiertoRef.current = true;
    setAbierto(true);
    void documentos.reload();
  };

  return (
    <details className="directiva-pendientes" onToggle={alDesplegar}>
      <summary>
        <Wrench size={14} aria-hidden="true" />
        Lo que todavía no se puede desde aquí — herramientas y prompts
      </summary>

      <ul className="directiva-pendiente-lista">
        <li><strong>Herramientas · qué puede usar y qué no</strong></li>
        <li><strong>Prompts · falta acordar qué son</strong></li>
      </ul>

      <p className="directiva-pendiente-porque">
        Ninguna de las dos tiene todavía una fuente única con autoridad en Cauce, así que no hay
        nada que editar desde aquí sin mentir. El pedido, por qué no se puede y qué falta para que
        tengan editor están en <code>{ROADMAP_DE_CAPAS.fichero}</code>, sección
        {' '}«{ROADMAP_DE_CAPAS.seccion}».
      </p>

      <p className="directiva-pendiente-donde">
        Mientras tanto la configuración de {alias} se toca por la TUI o por <code>docker exec</code>,
        con lo que eso implica: sin revisión y sin vuelta atrás. Arnés:{' '}
        <Dato contraste={contrasteDeUbicacion(undefined, medida.arnes)} midiendo={midiendo} />
        {'. '}$HOME:{' '}
        <Dato contraste={contrasteDeUbicacion(ubicacion.home, medida.home)} midiendo={midiendo} />
        {'. '}Contenedor:{' '}
        {/* No route publishes a measured container NAME (the directive carries a Docker hex id): declared-only. */}
        <Dato contraste={contrasteDeUbicacion(ubicacion.contenedor, undefined)} />
        {'. '}
      </p>
    </details>
  );
}
