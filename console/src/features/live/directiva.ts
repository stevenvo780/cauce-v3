import type { AgentDirective, AgentDirectiveFile } from '../../api/types';

/**
 * Detección de solapamientos entre las tres capas de directiva:
 * Capa 1 (role_brief): Identidad y límites de autonomía.
 * Capa 2 (CLAUDE.md / AGENTS.md): Reglas de entorno y operativas.
 * Capa 3 (memoria): Conocimiento persistido del arnés.
 */

export type TonoAvisoCapa = 'choque' | 'hueco' | 'nota';

export interface AvisoDeCapas {
  id: string;
  tono: TonoAvisoCapa;
  titulo: string;
  detalle: string;
  /** Los fragmentos concretos que lo disparan. Un aviso sin evidencia es una opinión. */
  evidencia: string[];
}

/** Sin tildes y en minúsculas: los briefs de la flota escriben «AUTONOMIA» y «autonomía». */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Giros para detectar declaraciones de autonomía y permisos.
 * Se buscan giros y no palabras sueltas para evitar falsos positivos.
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

/** Con qué giros habla un texto de autonomía o de permisos. Vacío = no habla. */
export function girosDeAutonomia(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const plano = normalizar(texto);
  return GIROS_DE_AUTONOMIA.filter(({ patron }) => patron.test(plano)).map(({ etiqueta }) => etiqueta);
}

/**
 * Si un texto abre declarando identidad. «Si un `CLAUDE.md` empieza con "Sos…", está invadiendo la
 * capa 1» — literal del diseño.
 *
 * Se mira sólo el ARRANQUE (primeras líneas con contenido) y no el fichero entero: un manual puede
 * mencionar «sos vos quien despliega» en mitad de un párrafo sin estar declarando identidad, y
 * marcar eso convertiría el aviso en ruido.
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
 * Los avisos de solapamiento entre capas.
 *
 * `publicado:false`, `medido:false` y `files:null` significan que los ficheros NO SE MIRARON.
 * Devuelve lista vacía a propósito —ni un «no tiene manual», ni un «no se pisan»—, porque las dos
 * frases serían afirmaciones sobre algo que nadie leyó. `files:null` conserva el cierre seguro ante
 * gateways legacy sin el discriminante `medido`. Quien pinta la pantalla explica por qué no pudo
 * mirar; ver `DirectivaTab`.
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
    // Sin texto no se puede cotejar. Y NO se asume que no se pisa: se dice que no se pudo mirar.
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
 * Las primeras líneas CON CONTENIDO de un texto, para el resumen del cajón.
 *
 * Salta las vacías en vez de contarlas: los briefs de la flota abren con una línea en blanco o con
 * un `#` de título más de una vez, y un resumen de «dos líneas» que gasta las dos en el hueco no
 * resume nada. Se recorta cada línea porque el resumen se pinta en un renglón: los espacios de
 * sangrado del `.md` original correrían el texto sin decir nada.
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
 * Estado de medición de una capa:
 * - `no-se-miro`: sin lectura o contenedor no medido
 * - `miro-y-no-hay`: lectura confirmada con resultado vacío
 * - `hay-datos`: presencia de ficheros o entradas
 */
export type MedicionDeCapa = 'cargando' | 'no-se-miro' | 'miro-y-no-hay' | 'hay-datos';

export interface RecursoDeCapa {
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

/** Conteo exacto, o límite inferior cuando `total:null` acredita un barrido cortado. */
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
