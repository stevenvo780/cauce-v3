import type {
  AgentDocumentGuardado, AgentDocumentItem, AgentDocumentsMap,
} from '../../api/types';

/**
 * THE LOGIC OF "WHAT CAN BE DONE WITH THIS FILE AND WHY NOT".
 *
 * It lives outside the component for the same reason as `directiva.ts` and `role-brief.ts`: exporting
 * functions from a component file breaks Vite's fast refresh and this console's lint runs with
 * `--max-warnings 0`. And because the rule that decides whether a document is offered editable must be
 * testable on its own.
 *
 * All of this exists for a single purpose: the screen must never say "not available" outright. There are
 * FOUR distinct reasons why a file might not be touched, and confusing them is what turns this view into
 * decoration:
 *
 *   1. The gateway does not publish the route       -> it was not checked. Fixed by deploying.
 *   2. The route is not MEASURED in the container   -> the route is not trustworthy. Fixed by measuring.
 *   3. There is no channel to the agent's disk      -> a piece that does not yet exist is missing.
 *   4. The file mixes credentials                   -> it will NEVER be writable this way, and rightly so.
 *
 * All four look the same on screen and mean opposite things. The 4th is a decision; the 1st is a pending
 * deployment. Painting them the same way would make the operator wait for something "to be fixed" that is
 * already correct, or give up on something that only needs to be deployed.
 */

type ModoDocumento = 'entero' | 'proyectado' | 'solo-lectura';

/**
 * What can be done with a document.
 *
 * `proyectado` is the case of `openclaw.json`: the whole file NEVER leaves —it carries `auth` and
 * `secrets`— but some of its fields do. It is not "half-editable": it is a different document, the one
 * being seen, and that has to be said in those words before someone believes they are looking at the full
 * file and deletes what they do not see.
 */
export function modoDeDocumento(item: AgentDocumentItem): ModoDocumento {
  if (item.editable) return 'entero';
  if ((item.projected_fields?.length ?? 0) > 0) return 'proyectado';
  return 'solo-lectura';
}

interface Explicacion {
  titulo: string;
  detalle: string;
  /** `true` if this is fixed by a deployment or a measurement; `false` if it is a decision. */
  pendiente: boolean;
}

/**
 * Translates the server's failure into something that can be read and, above all, ACTED ON.
 *
 * The server's `detalle` is shown AS-IS when it comes, instead of being rewritten: those messages are written
 * in the gateway with the measured reason (why `skills` is not served, why there is no channel), and
 * rewriting them here would mean keeping the explanation in two places that can diverge. What is added is
 * the title and whether there is something to do.
 */
export function explicarFallo(status: number | undefined, mensajeServidor?: string): Explicacion {
  const detalle = mensajeServidor?.trim();
  switch (status) {
    case 409:
      return {
        titulo: 'La ruta de este fichero no está medida',
        detalle: detalle ??
          'Nadie ha mirado todavía dentro del contenedor de este agente qué arnés corre ni con ' +
          'qué HOME. Sin esa medición la ruta sería una suposición, y el registro se equivoca de ' +
          'arnés en 5 de los 14 alias.',
        pendiente: true,
      };
    case 503:
      return {
        titulo: 'Todavía no hay camino hasta el disco de este agente',
        detalle: detalle ??
          'La consola no tiene forma de leer ni escribir ficheros dentro del contenedor. Falta ' +
          'esa pieza; no es que este fichero esté vacío.',
        pendiente: true,
      };
    case 403:
      return {
        titulo: 'Este fichero no se sirve por esta vía',
        detalle: detalle ?? 'Mezcla configuración con credenciales.',
        pendiente: false,
      };
    case 413:
      return {
        titulo: 'El fichero pasa del tope',
        detalle: detalle ?? 'Es demasiado grande para editarlo desde aquí.',
        pendiente: false,
      };
    case 404:
      return {
        titulo: 'Este agente no tiene ese documento',
        detalle: detalle ?? 'El arnés que corre no usa ese fichero.',
        pendiente: false,
      };
    default:
      return {
        titulo: 'No se pudo leer el fichero',
        detalle: detalle ?? 'El servidor no dio una razón.',
        pendiente: true,
      };
  }
}

/**
 * The header notice when the routes are NOT measured.
 *
 * It returns the server's `caveat` if it comes. It never invents one: if the gateway says the source is
 * `measured`, there is nothing to warn about and returning a generic notice "just in case" would be a guard
 * that cries wolf, which is how the notice that actually matters ends up being ignored.
 */
export function avisoDeFuente(mapa: AgentDocumentsMap): string | undefined {
  if (!mapa.publicado) return mapa.motivo;
  if (mapa.facts_source === 'measured') return undefined;
  return mapa.caveat;
}

/**
 * The notice to show BEFORE allowing save, not after.
 *
 * Two cases, and both are the kind people later regret: a `settings.json` may carry `hooks`, which are shell
 * commands the harness executes on its own —editing it from a web is executing code inside the container—;
 * and a projected document shows a part of the file, so deleting from the view deletes from the document.
 */
export function avisoAntesDeGuardar(item: AgentDocumentItem): string | undefined {
  if (item.warning) return item.warning;
  if (modoDeDocumento(item) === 'proyectado') {
    return 'De este fichero sólo ves una parte. Lo que quites de aquí se quita del documento.';
  }
  return undefined;
}

/** Is there something unsaved? Exact comparison: a trailing space also counts as a change. */
export function hayCambios(original: string, borrador: string): boolean {
  return original !== borrador;
}

/**
 * A lone 2xx does not mean "applied". Only the new contract, which carries the probe's ACK of writing in
 * the container, authorizes that word. The defensive branch avoids lying during a staged deployment if an
 * old gateway returns the previous shape.
 */
export function mensajeDeGuardado(resultado: AgentDocumentGuardado): string {
  if (esAckAplicado(resultado)) {
    return `Aplicado en ${resultado.path}: la sonda confirmó el ACK de escritura (${String(resultado.bytes)} bytes).`;
  }
  return `El gateway respondió 2xx, pero la aplicación no quedó confirmada por un ACK completo.`;
}

interface AckAplicado {
  readonly ok: true;
  readonly state: 'applied';
  readonly evidence: 'probe_write_ack';
  readonly path: string;
  readonly sha: string;
  readonly bytes: number;
}

/** Only this complete form authorizes clearing the visible draft. */
export function esAckAplicado(resultado: AgentDocumentGuardado): resultado is AckAplicado {
  return resultado.ok === true
    && resultado.state === 'applied'
    && resultado.evidence === 'probe_write_ack'
    && typeof resultado.path === 'string' && resultado.path.startsWith('/')
    && typeof resultado.sha === 'string' && /^[0-9a-f]{64}$/.test(resultado.sha)
    && typeof resultado.bytes === 'number' && Number.isSafeInteger(resultado.bytes)
    && resultado.bytes >= 0;
}
