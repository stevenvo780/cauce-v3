import { AlertTriangle, BookOpen, Brain, FileWarning, IdCard } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import type { AgentDirective, ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState, Time } from '../../components/ui';
import { RoleBriefTab, type RoleBriefTabProps } from './RoleBriefTab';
import { avisosDeCapas, totalDeMemoria, type AvisoDeCapas } from './directiva';

/**
 * LAS TRES CAPAS DE DIRECTIVA DE UN ALIAS, JUNTAS Y ROTULADAS POR SU FIN.
 *
 * Steven señaló que la consola sólo editaba «los prompts que llegan en el mensaje» y no veía el
 * `CLAUDE.md` del agente. Al medirlo apareció algo peor que un olvido (el diseño entero está en
 * `/workspace/DISENO-TRES-CAPAS-DE-DIRECTIVA.md`): no son dos capas sino TRES, sólo una era
 * visible, y las otras dos están desordenadas justamente porque nadie las ve —janus tiene DOS
 * `CLAUDE.md` a la vez, gaia no tiene ninguno, y la autonomía está escrita por duplicado en los
 * 14 alias—.
 *
 * Ver las tres al lado ES el arreglo: la duplicación no se descubre leyendo un fichero, se
 * descubre poniéndolo al lado del otro. Por eso esta pestaña no es una vista nueva sino la de
 * «Rol» ensanchada, en el mismo cajón donde el operador ya mira al bot.
 *
 * QUÉ FALTA, Y SE DICE EN PANTALLA: las capas 2 y 3 son ficheros DENTRO del contenedor del alias,
 * y sólo el gateway puede mirarlos. El endpoint todavía no existe. Mientras no exista, esta
 * pestaña muestra el contrato y declara que NO SE MIRÓ. Lo que no hace —y es la mitad del
 * trabajo— es pintar «este alias no tiene CLAUDE.md» sobre una lectura que nunca ocurrió: sería
 * cierto para gaia y falso para janus, con la misma cara de seguridad en los dos casos.
 */

export type DirectivaTabProps = RoleBriefTabProps;

/** Sólo para el aviso de solapamiento: el texto del rol tal y como está GUARDADO. */
function briefGuardado(snapshot: ConfigurationSnapshot | undefined, tenantId: string, alias: string): string | undefined {
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return undefined;
  const fila = agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  return typeof fila?.role_brief === 'string' ? fila.role_brief : undefined;
}

export function DirectivaTab({ tenantId, alias, borrador, onBorrador }: DirectivaTabProps) {
  const api = useApi();
  /*
   * Dos lecturas de `/v3/console/config` cuando se abre la pestaña: ésta y la de `RoleBriefTab`.
   * Es a propósito y es el precio de NO tocar el editor del rol, que tiene su propio manejo de
   * revisión, de conflicto optimista y de relectura tras guardar —siete casos de prueba que
   * describen fallos ya cometidos—. Refactorizarlo para ahorrar un GET de configuración sería
   * cambiar algo que funciona por algo que hay que volver a demostrar.
   */
  const config = useResource(`directiva-config-${tenantId}-${alias}`, () => api.getConfiguration());
  const directiva = useResource(
    `directiva-ficheros-${tenantId}-${alias}`,
    () => api.getAgentDirective(tenantId, alias),
  );

  const avisos = useMemo(
    () => avisosDeCapas(briefGuardado(config.data, tenantId, alias), directiva.error ? undefined : directiva.data),
    [config.data, tenantId, alias, directiva.data, directiva.error],
  );

  return (
    <div className="directiva">
      <AvisosDeSolapamiento avisos={avisos} />

      <section className="directiva-capa" aria-label="Capa 1: rol declarado">
        <CapaCabecera
          icono={<IdCard size={15} aria-hidden="true" />}
          numero={1}
          titulo="Rol declarado"
          fin="QUIÉN SOS y QUÉ PODÉS DECIDIR"
          fuente="agents.role_brief · base de datos · viaja en CADA entrega"
        />
        <p className="directiva-porque">
          Es la única capa que sigue siendo verdad si se recrea el contenedor o cambia el arnés, así
          que es la única que debe fijar identidad, límites de autonomía y a quién se escala.
        </p>
        <RoleBriefTab tenantId={tenantId} alias={alias} borrador={borrador} onBorrador={onBorrador} />
      </section>

      <section className="directiva-capa" aria-label="Capa 2: manual del sitio">
        <CapaCabecera
          icono={<BookOpen size={15} aria-hidden="true" />}
          numero={2}
          titulo="Manual del sitio · CLAUDE.md"
          fin="CÓMO SE TRABAJA AQUÍ"
          fuente="fichero dentro del contenedor del alias · no viaja con la entrega"
        />
        <p className="directiva-porque">
          Rutas, comandos, convenciones, qué no tocar, cómo se despliega. No repite identidad ni
          autonomía: si empieza con «Sos…», está invadiendo la capa 1.
        </p>
        <CapaDeFicheros recurso={directiva} />
      </section>

      <section className="directiva-capa" aria-label="Capa 3: memoria">
        <CapaCabecera
          icono={<Brain size={15} aria-hidden="true" />}
          numero={3}
          titulo="Memoria"
          fin="LO QUE ESE AGENTE APRENDIÓ"
          fuente="~/.claude/projects · ~/.openclaw/memory · sólo lectura"
        />
        <p className="directiva-porque">
          Hechos que midió él mismo. Ni identidad ni manual. Desde acá se lee el índice: el
          contenido se edita donde se escribió, no desde la consola.
        </p>
        <CapaDeMemoria recurso={directiva} />
      </section>
    </div>
  );
}

function CapaCabecera({ icono, numero, titulo, fin, fuente }: {
  icono: ReactNode; numero: number; titulo: string; fin: string; fuente: string;
}) {
  return (
    <header className="directiva-capa-head">
      <span className="directiva-capa-icono" aria-hidden="true">{icono}</span>
      <div>
        <h3>Capa {numero} · {titulo}</h3>
        {/* El fin va ARRIBA del nombre técnico: la pregunta que resuelve cada capa es lo que
            decide dónde va a parar cada frase, y es justo lo que hoy nadie tiene delante. */}
        <p className="directiva-capa-fin">{fin}</p>
        <p className="directiva-capa-fuente">{fuente}</p>
      </div>
    </header>
  );
}

function AvisosDeSolapamiento({ avisos }: { avisos: AvisoDeCapas[] }) {
  if (avisos.length === 0) return null;
  return (
    <div className="directiva-avisos" role="group" aria-label="Avisos de solapamiento entre capas">
      {avisos.map((aviso) => (
        <div key={aviso.id} className="directiva-aviso" data-tono={aviso.tono} role={aviso.tono === 'choque' ? 'alert' : 'note'}>
          <span aria-hidden="true">
            {aviso.tono === 'choque' ? <AlertTriangle size={15} /> : <FileWarning size={15} />}
          </span>
          <div>
            <strong>{aviso.titulo}</strong>
            <p>{aviso.detalle}</p>
            {aviso.evidencia.length > 0 ? (
              <ul className="directiva-evidencia">
                {aviso.evidencia.map((dato) => <li key={dato}><code>{dato}</code></li>)}
              </ul>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * El texto EXACTO con el que se declara que una capa no se pudo mirar.
 *
 * Es una función y no una cadena suelta porque las capas 2 y 3 tienen que decir lo mismo: que la
 * consola no vio nada, no que no haya nada. La diferencia es la que separa un diagnóstico de una
 * invención, y en esta consola ya costó caro confundirlas.
 */
function NoSeMiro({ motivo, que }: { motivo: string | undefined; que: string }) {
  return (
    <EmptyState>
      No se pudo mirar {que} de este alias: {motivo ?? 'el servidor no dio un motivo.'} Eso NO
      significa que no exista —significa que la consola no lo vio—. El día que el gateway publique
      {' '}<code>GET /v3/console/agents/:tenant/:alias/directive</code>, esta sección se llena sola.
    </EmptyState>
  );
}

type RecursoDirectiva = { data?: AgentDirective; error?: Error; loading: boolean };

function CapaDeFicheros({ recurso }: { recurso: RecursoDirectiva }) {
  if (recurso.loading && !recurso.data) return <p className="muted">Buscando los CLAUDE.md del contenedor…</p>;
  if (recurso.error && !recurso.data) return <NoSeMiro que="el manual del sitio" motivo={recurso.error.message} />;
  if (!recurso.data?.publicado) return <NoSeMiro que="el manual del sitio" motivo={recurso.data?.motivo} />;

  const ficheros = recurso.data.files ?? [];
  if (ficheros.length === 0) {
    return (
      <EmptyState>
        El servidor miró el contenedor{recurso.data.container_id ? ` (${recurso.data.container_id})` : ''} y no
        hay ningún <code>CLAUDE.md</code>. Este alias arranca cada sesión sin manual del sitio.
      </EmptyState>
    );
  }

  return (
    <ul className="directiva-ficheros">
      {ficheros.map((fichero, indice) => (
        <li key={fichero.path ?? indice}>
          <div className="directiva-fichero-head">
            <code>{fichero.path ?? 'ruta sin informar'}</code>
            <span className="chip">{fichero.scope === 'user' ? 'nivel usuario' : fichero.scope === 'workspace' ? 'espacio de trabajo' : 'nivel sin informar'}</span>
            <span className="directiva-fichero-meta">
              {typeof fichero.bytes === 'number' ? `${fichero.bytes} bytes` : 'tamaño sin informar'}
              {' · '}<Time value={fichero.modified_at} />
            </span>
          </div>
          {typeof fichero.text === 'string' ? (
            <details>
              <summary>Ver el contenido{fichero.truncated ? ' (recortado por el servidor)' : ''}</summary>
              <pre className="directiva-fichero-texto">{fichero.text}</pre>
            </details>
          ) : (
            <p className="directiva-fichero-meta">
              El servidor lo lista pero no publica su contenido: no se puede cotejar con el rol.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CapaDeMemoria({ recurso }: { recurso: RecursoDirectiva }) {
  if (recurso.loading && !recurso.data) return <p className="muted">Leyendo el índice de memoria…</p>;
  if (recurso.error && !recurso.data) return <NoSeMiro que="la memoria" motivo={recurso.error.message} />;
  if (!recurso.data?.publicado) return <NoSeMiro que="la memoria" motivo={recurso.data?.motivo} />;

  const memoria = recurso.data.memory;
  const total = totalDeMemoria(recurso.data);
  if (!memoria || total === undefined) {
    return (
      <EmptyState>
        Este gateway publica los ficheros del alias pero no su índice de memoria, así que cuánto
        recuerda es un dato que no tenemos. No es cero.
      </EmptyState>
    );
  }

  const entradas = memoria.entries ?? [];
  return (
    <div className="directiva-memoria">
      <p className="directiva-memoria-resumen">
        <strong>{total}</strong> entrada(s) en <code>{memoria.root ?? 'raíz sin informar'}</code>
        {memoria.truncated ? ` · se listan las ${entradas.length} primeras` : ''}
      </p>
      {entradas.length === 0 ? (
        <EmptyState>El índice llegó vacío: el servidor miró y este alias no tiene memoria escrita.</EmptyState>
      ) : (
        <ul className="directiva-memoria-lista">
          {entradas.map((entrada, indice) => (
            <li key={entrada.path ?? indice}>
              <code>{entrada.path ?? 'ruta sin informar'}</code>
              <span className="directiva-fichero-meta">
                {typeof entrada.bytes === 'number' ? `${entrada.bytes} bytes` : 'tamaño sin informar'}
                {' · '}<Time value={entrada.modified_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
