import { Eye, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentDirective } from '../../../api/types';
import { Time } from '../../../components/ui';
import { Notice } from '../../../components/kit';
import { medicionDeCapa, totalDeMemoria } from '../directiva';

const META = 'm-0 text-xs text-muted';
const CHIP = 'rounded-full bg-muted-bg px-2 py-0.5 text-[11px] font-medium text-fg-2';

interface RecursoDirectiva { data?: AgentDirective; error?: Error; loading: boolean }

function SinMedir({ children }: { children: ReactNode }) {
  return (
    <Notice tone="warn" data-medicion="no-medida" role="note">
      <p className="flex items-center gap-1.5 font-semibold">
        <EyeOff size={14} aria-hidden="true" /> No se pudo mirar
      </p>
      <p>{children}</p>
    </Notice>
  );
}

function NoSeMiro({ motivo, que }: { motivo: string | undefined; que: string }) {
  return (
    <SinMedir>
      No se pudo mirar {que} de este alias: el gateway todavía no publica esta lectura
      {motivo ? <> (dijo: «{motivo}»)</> : ' y no dio un motivo'}. Eso NO significa que no exista
      —significa que la consola no lo vio—. El día que publique{' '}
      <code>GET /v3/console/agents/:tenant/:alias/directive</code>, esta columna se llena sola.
    </SinMedir>
  );
}

function LecturaFallida({ motivo, que }: { motivo: string; que: string }) {
  return (
    <SinMedir>
      No se pudo mirar {que} de este alias: el servidor respondió «{motivo}». Eso NO significa
      que no exista —significa que la lectura falló o que el recurso no es visible para esta
      sesión—.
    </SinMedir>
  );
}

function MiroYNoHay({ children }: { children: ReactNode }) {
  return (
    <Notice data-medicion="medida-vacia" role="note">
      <p className="flex items-center gap-1.5 font-semibold">
        <Eye size={14} aria-hidden="true" /> El servidor miró
      </p>
      <p>{children}</p>
    </Notice>
  );
}

export function CapaDeFicheros({ recurso }: { recurso: RecursoDirectiva }) {
  const medicion = medicionDeCapa(recurso, 'files');
  if (medicion === 'cargando') return <p className="m-0 text-muted">Buscando el manual medido del runtime…</p>;
  if (medicion === 'no-se-miro') {
    if (recurso.error) {
      return <LecturaFallida que="el manual del sitio" motivo={recurso.error.message} />;
    }
    return <NoSeMiro que="el manual del sitio" motivo={recurso.data?.motivo} />;
  }
  if (medicion === 'miro-y-no-hay') {
    return (
      <MiroYNoHay>
        Miró el contenedor{recurso.data?.container_id ? ` (${recurso.data.container_id})` : ''} y no
        hay ningún manual estándar acreditado en las rutas medidas. Esto no prueba ausencia de
        reglas o fallbacks que la respuesta declare fuera de cobertura.
      </MiroYNoHay>
    );
  }

  const ficheros = recurso.data?.files ?? [];
  return (
    <div className="grid gap-2">
      <p className={META}>
        {recurso.data?.manual_order === 'codex_precedence'
          ? 'Orden efectivo de Codex: más profundo prevalece; override gana dentro del nivel.'
          : recurso.data?.manual_order === 'claude_load_order'
            ? 'Orden de carga medido de Claude; no se inventa una precedencia adicional.'
            : 'Orden medido del runtime.'}
      </p>
      {(recurso.data?.context_limitations ?? []).map((limitacion) => (
        <p key={limitacion} className={META} role="note">Cobertura limitada: {limitacion}</p>
      ))}
      <ul className="m-0 grid list-none gap-2 p-0">
        {ficheros.map((fichero, indice) => (
          <li key={fichero.path ?? indice} className="grid gap-1.5 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code className="break-all">{fichero.path ?? 'ruta sin informar'}</code>
              <span className={CHIP}>{fichero.scope === 'user' ? 'nivel usuario' : fichero.scope === 'workspace' ? 'espacio de trabajo' : 'nivel sin informar'}</span>
              {typeof fichero.precedence === 'number' ? <span className={CHIP}>orden {fichero.precedence + 1}</span> : null}
              <span className={META}>
                {typeof fichero.bytes === 'number' ? `${String(fichero.bytes)} bytes` : 'tamaño sin informar'}
                {' · '}<Time value={fichero.modified_at} />
              </span>
            </div>
            {typeof fichero.error === 'string' ? (
              <p className="m-0 text-xs text-danger-ink" role="alert">
                No se pudo leer ({fichero.error}): {fichero.reason ?? 'sin detalle'}. No se toma como ausencia.
              </p>
            ) : typeof fichero.text === 'string' ? (
              <details>
                <summary className="cursor-pointer text-xs font-medium">Ver el contenido{fichero.truncated ? ' (recortado por el servidor)' : ''}</summary>
                <pre className="m-0 mt-1.5 max-h-80 overflow-auto rounded-md bg-subtle p-2 font-mono text-xs break-words whitespace-pre-wrap">{fichero.text}</pre>
              </details>
            ) : (
              <p className={META}>
                El servidor lo lista pero no publica su contenido: no se puede cotejar con el rol.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CapaDeMemoria({ recurso }: { recurso: RecursoDirectiva }) {
  const medicion = medicionDeCapa(recurso, 'memory');
  if (medicion === 'cargando') return <p className="m-0 text-muted">Leyendo el índice de memoria…</p>;
  if (medicion === 'no-se-miro') {
    if (recurso.error) {
      return <LecturaFallida que="la memoria" motivo={recurso.error.message} />;
    }
    const publicaFicherosPeroNoMemoria =
      recurso.data?.publicado === true && recurso.data.medido !== false
      && recurso.data.files != null && recurso.data.memory == null;
    if (publicaFicherosPeroNoMemoria) {
      return (
        <SinMedir>
          Este gateway publica los ficheros del alias pero no su índice de memoria, así que cuánto
          recuerda es un dato que no tenemos. No es cero.
        </SinMedir>
      );
    }
    const memoryFailure = recurso.data?.memory;
    const motivoMemoria = memoryFailure && 'error' in memoryFailure
      ? memoryFailure.reason
      : undefined;
    return <NoSeMiro que="la memoria" motivo={motivoMemoria ?? recurso.data?.motivo} />;
  }

  const memoria = recurso.data?.memory;
  const total = totalDeMemoria(recurso.data);
  if (!memoria || total === undefined) {
    return (
      <SinMedir>
        Este gateway publica los ficheros del alias pero no su índice de memoria, así que cuánto
        recuerda es un dato que no tenemos. No es cero.
      </SinMedir>
    );
  }

  const entradas = memoria.entries ?? [];
  const limiteInferior = memoria.total === null
    && typeof memoria.observed_at_least === 'number';
  return (
    <div className="grid gap-2">
      <p className="m-0 text-[13px]">
        <strong>{limiteInferior ? `≥ ${String(total)}` : total}</strong> entrada(s) en{' '}
        <code>{memoria.root ?? 'raíz sin informar'}</code>
        {limiteInferior
          ? ` · el barrido alcanzó su límite; se observaron como mínimo ${String(total)}`
          : memoria.truncated ? ` · se listan las ${String(entradas.length)} primeras` : ''}
      </p>
      {entradas.length === 0 ? (
        medicion === 'miro-y-no-hay' ? (
          <MiroYNoHay>El índice llegó vacío: miró y este alias no tiene memoria escrita.</MiroYNoHay>
        ) : (
          <p className="m-0 text-muted">El barrido fue parcial y no publicó entradas de muestra.</p>
        )
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {entradas.map((entrada, indice) => (
            <li key={entrada.path ?? indice} className="flex flex-wrap items-center gap-x-2">
              <code className="break-all">{entrada.path ?? 'ruta sin informar'}</code>
              <span className={META}>
                {typeof entrada.bytes === 'number' ? `${String(entrada.bytes)} bytes` : 'tamaño sin informar'}
                {' · '}<Time value={entrada.modified_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
