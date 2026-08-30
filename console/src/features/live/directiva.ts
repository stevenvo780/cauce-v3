import type { AgentDirective, AgentDirectiveFile } from '../../api/types';

/**
 * Detection of overlaps between the three directive layers:
 * Layer 1 (role_brief): Identity and autonomy boundaries.
 * Layer 2 (CLAUDE.md / AGENTS.md): Environment and operational rules.
 * Layer 3 (memory): Persisted harness knowledge.
 */

type TonoAvisoCapa = 'choque' | 'hueco' | 'nota';

export interface AvisoDeCapas {
  id: string;
  tono: TonoAvisoCapa;
  titulo: string;
  detalle: string;
  /** The concrete fragments that trigger it. A warning without evidence is an opinion. */
  evidencia: string[];
}

/** Without accents and in lowercase: fleet briefs write both "AUTONOMIA" and "autonomía". */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Turns of phrase to detect declarations of autonomy and permissions.
 * Phrases are matched instead of standalone words to avoid false positives.
 */
const GIROS_DE_AUTONOMIA: { patron: RegExp; etiqueta: string }[] = [
  { patron: /\bautonomia\b/, etiqueta: 'autonomía' },
  { patron: /ped(i|ir|is|ile)\s+permiso/, etiqueta: 'pedir permiso' },
  { patron: /sin\s+ped(ir|i)\s+permiso/, etiqueta: 'sin pedir permiso' },
  { patron: /\bdecid(i|ir|is)\s+y\s+actu(a|ar|as)/, etiqueta: 'decidí y actuá' },
  { patron: /\bno\s+preguntes\b/, etiqueta: 'no preguntes' },
  { patron: /sin\s+preguntar\b/, etiqueta: 'sin preguntar' },
  { patron: /\bconsulta(r|)\s+(a\s+)?(un\s+)?humano/, etiqueta: 'consultar a un humano' },
  { patron: /\bescala(r|le|s|)\s+a\b/, etiqueta: 'escalar a' },
  { patron: /\bautoriza(cion|r|do)\b/, etiqueta: 'autorización' },
  { patron: /\bno\s+toques\b/, etiqueta: 'no toques' },
  { patron: /\bprohibido\b/, etiqueta: 'prohibido' },
];

/** Which phrases a text uses to talk about autonomy or permissions. Empty = it does not talk. */
export function girosDeAutonomia(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const plano = normalizar(texto);
  return GIROS_DE_AUTONOMIA.filter(({ patron }) => patron.test(plano)).map(({ etiqueta }) => etiqueta);
}

/**
 * Whether a text opens by declaring identity. "If a `CLAUDE.md` starts with 'You are...' it is
 * invading layer 1" — a literal of the design.
 *
 * Only the BEGINNING (the first content lines) is inspected, not the whole file: a manual may
 * mention "you are the one who deploys" in the middle of a paragraph without declaring identity,
 * and flagging that would turn the warning into noise.
 */
export function abreDeclarandoIdentidad(texto: string | null | undefined): string | undefined {
  if (!texto) return undefined;
  const primeras = texto.split('\n').map((linea) => linea.trim())
    .filter((linea) => linea.length > 0 && !linea.startsWith('#') && !linea.startsWith('>'))
    .slice(0, 3);
  for (const linea of primeras) {
    if (/^(sos|eres|tu rol es|tu nombre es|you are)\b/.test(normalizar(linea))) {
      return linea.slice(0, 120);
    }
  }
  return undefined;
}

function rotuloDeFichero(fichero: AgentDirectiveFile): string {
  return fichero.path ?? (fichero.scope === 'user' ? '~/.claude/CLAUDE.md' : 'CLAUDE.md sin ruta declarada');
}

/**
 * The overlap warnings between layers.
 *
 * `publicado:false`, `medido:false` and `files:null` mean the files WERE NOT INSPECTED. It returns
 * an empty list on purpose — neither a "no manual" nor a "no overlap" — because both statements
 * would be claims about something nobody read. `files:null` preserves the safe closure against
 * legacy gateways without the `medido` discriminator. The screen renderer explains why it could
 * not look; see `DirectivaTab`.
 */
export function avisosDeCapas(roleBrief: string | null | undefined, directiva: AgentDirective | undefined): AvisoDeCapas[] {
  if (!directiva?.publicado || directiva.medido === false || directiva.files == null) return [];
  const ficheros = directiva.files ?? [];
  const fallos = ficheros.filter((fichero) => typeof fichero.error === 'string');
  const existentes = ficheros.filter((fichero) => typeof fichero.error !== 'string');
  const avisos: AvisoDeCapas[] = [];

  const girosDelBrief = girosDeAutonomia(roleBrief);

  for (const fallo of fallos) {
    avisos.push({
      id: `lectura-fallida:${rotuloDeFichero(fallo)}`,
      tono: 'nota',
      titulo: 'Falló la lectura de un manual candidato',
      detalle: `${rotuloDeFichero(fallo)} no se pudo leer (${fallo.error ?? 'error'}): `
        + `${fallo.reason ?? 'sin detalle'}. No se toma como ausente ni como existente.`,
      evidencia: [rotuloDeFichero(fallo)],
    });
  }

  for (const fichero of existentes) {
    // Without text we cannot compare. And we do NOT assume no overlap: we say we could not look.
    if (typeof fichero.text !== 'string') {
      avisos.push({
        id: `sin-texto:${rotuloDeFichero(fichero)}`,
        tono: 'nota',
        titulo: 'No se puede cotejar este manual con el rol',
        detalle: `El servidor lista ${rotuloDeFichero(fichero)} pero no publica su contenido, así que `
          + 'no se sabe si repite la autonomía del rol. No es «no la repite».',
        evidencia: [rotuloDeFichero(fichero)],
      });
      continue;
    }

    const girosDelManual = girosDeAutonomia(fichero.text);
    const compartidos = girosDelManual.filter((giro) => girosDelBrief.includes(giro));
    if (compartidos.length > 0) {
      avisos.push({
        id: `autonomia-duplicada:${rotuloDeFichero(fichero)}`,
        tono: 'choque',
        titulo: 'La autonomía está escrita en dos capas',
        detalle: `El rol declarado y ${rotuloDeFichero(fichero)} hablan los dos de lo mismo. La autonomía `
          + 'va SÓLO en el rol: es lo único que viaja en cada entrega y sigue siendo verdad si el '
          + 'contenedor se recrea. Cuando las dos versiones diverjan, nadie va a saber cuál manda.',
        evidencia: compartidos,
      });
    }

    const identidad = abreDeclarandoIdentidad(fichero.text);
    if (identidad) {
      avisos.push({
        id: `identidad-en-manual:${rotuloDeFichero(fichero)}`,
        tono: 'choque',
        titulo: 'El manual abre declarando identidad',
        detalle: `${rotuloDeFichero(fichero)} empieza diciendo quién es el agente, que es el trabajo del `
          + 'rol declarado. El manual responde a «cómo se trabaja aquí», no a «quién sos».',
        evidencia: [identidad],
      });
    }
  }

  if (existentes.length > 1) {
    const detalle = directiva.manual_order === 'codex_precedence'
      ? 'Codex los aplica en el orden mostrado: los niveles más profundos tienen mayor precedencia; '
        + 'AGENTS.override.md gana sobre AGENTS.md dentro del mismo nivel.'
      : directiva.manual_order === 'claude_load_order'
        ? 'Claude los carga en el orden mostrado (usuario, ancestros y nivel local). La vista no '
          + 'convierte ese orden de carga en una regla de precedencia que el runtime no acreditó.'
        : 'Se muestran en el orden medido por el runtime.';
    avisos.push({
      id: 'dos-manuales',
      tono: 'nota',
      titulo: `Este alias carga ${String(existentes.length)} manuales`,
      detalle,
      evidencia: existentes.map(rotuloDeFichero),
    });
  }

  const porHuella = new Map<string, AgentDirectiveFile[]>();
  for (const fichero of existentes) {
    if (typeof fichero.sha !== 'string') continue;
    const grupo = porHuella.get(fichero.sha) ?? [];
    grupo.push(fichero);
    porHuella.set(fichero.sha, grupo);
  }
  for (const [huella, duplicados] of porHuella) {
    if (duplicados.length < 2) continue;
    avisos.push({
      id: `manuales-duplicados:${huella}`,
      tono: 'nota',
      titulo: 'El mismo manual está duplicado en varios niveles',
      detalle: 'Las huellas SHA-256 coinciden byte por byte. La copia duplicada añade ambigüedad '
        + 'operativa aunque hoy diga exactamente lo mismo.',
      evidencia: duplicados.map(rotuloDeFichero),
    });
  }

  if (existentes.length === 0 && fallos.length === 0) {
    avisos.push({
      id: 'sin-manual',
      tono: 'hueco',
      titulo: 'No hay manual estándar acreditado en los niveles medidos',
      detalle: 'El servidor miró las rutas estándar y no encontró un manual efectivo. Esto no '
        + 'acredita ausencia de reglas o fallbacks que la propia respuesta declare fuera de cobertura.',
      evidencia: [directiva.container_id ?? 'contenedor sin identificar'],
    });
  }

  if (girosDelBrief.length === 0) {
    avisos.push({
      id: 'brief-sin-autonomia',
      tono: 'hueco',
      titulo: 'El rol declarado no dice qué puede decidir solo',
      detalle: 'La capa 1 es la única que debería fijar los límites de autonomía, y este rol no los '
        + 'menciona. Si el agente los tiene, están escritos en algún sitio que no viaja con la entrega.',
      evidencia: [],
    });
  }

  return avisos;
}

/**
 * The first content lines of a text, for the slot's summary.
 *
 * Empty lines are skipped rather than counted: fleet briefs open with a blank line or with a
 * title `#` more than once, and a "two lines" summary that spends both on the gap summarizes
 * nothing. Each line is trimmed because the summary is rendered on a single line: indentation
 * spaces from the original `.md` would shift the text without saying anything.
 */
export function primerasLineas(texto: string | null | undefined, cuantas: number): string[] {
  if (!texto) return [];
  return texto
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0)
    .slice(0, cuantas);
}

/**
 * Measurement status of a layer:
 * - `no-se-miro`: not read or container not measured
 * - `miro-y-no-hay`: read confirmed with an empty result
 * - `hay-datos`: files or entries present
 */
type MedicionDeCapa = 'cargando' | 'no-se-miro' | 'miro-y-no-hay' | 'hay-datos';

interface RecursoDeCapa {
  data?: AgentDirective;
  error?: Error;
  loading?: boolean;
}

export function medicionDeCapa(recurso: RecursoDeCapa, campo: 'files' | 'memory'): MedicionDeCapa {
  if (!recurso.data) return recurso.loading ? 'cargando' : 'no-se-miro';
  if (!recurso.data.publicado) return 'no-se-miro';
  if (recurso.data.medido === false) return 'no-se-miro';

  if (campo === 'files') {
    const ficheros = recurso.data.files;
    if (ficheros === null || ficheros === undefined) return 'no-se-miro';
    return ficheros.length === 0 ? 'miro-y-no-hay' : 'hay-datos';
  }

  const memoria = recurso.data.memory;
  if (memoria === null || memoria === undefined) return 'no-se-miro';
  if ('error' in memoria && memoria.error !== undefined) return 'no-se-miro';
  const total = totalDeMemoria(recurso.data);
  if (total === undefined) return 'no-se-miro';
  if (memoria.total === null && memoria.truncated === true) return 'hay-datos';
  return total === 0 ? 'miro-y-no-hay' : 'hay-datos';
}

/** Exact count, or lower bound when `total:null` certifies a truncated scan. */
export function totalDeMemoria(directiva: AgentDirective | undefined): number | undefined {
  const memoria = directiva?.memory;
  if (!memoria) return undefined;
  if ('error' in memoria && memoria.error !== undefined) return undefined;
  if (typeof memoria.total === 'number') return memoria.total;
  if (memoria.total === null && typeof memoria.observed_at_least === 'number') {
    return memoria.observed_at_least;
  }
  return Array.isArray(memoria.entries) ? memoria.entries.length : undefined;
}
