import type { AgentDirective, AgentDirectiveFile } from '../../api/types';

/**
 * LAS TRES CAPAS DE DIRECTIVA, y el aviso de cuándo se pisan.
 *
 * Fuera del componente por lo mismo que `role-brief.ts`: exportar funciones desde un fichero de
 * componentes rompe el fast refresh de Vite y el lint de esta consola corre con
 * `--max-warnings 0`. Y porque la regla que decide si dos capas se contradicen tiene que poder
 * probarse sola, sin montar un cajón.
 *
 * El diseño (`/workspace/DISENO-TRES-CAPAS-DE-DIRECTIVA.md`, medido sobre producción el
 * 23-ago-2026) reparte así los tres sitios donde hoy vive la directiva de un alias:
 *
 *   Capa 1 · `role_brief` → QUIÉN SOS y QUÉ PODÉS DECIDIR. Es la ÚNICA que debe hablar de
 *            autonomía y de permisos, porque es la única que viaja en cada entrega y sigue siendo
 *            verdad aunque se recree el contenedor.
 *   Capa 2 · `CLAUDE.md` → CÓMO SE TRABAJA AQUÍ. Rutas, comandos, convenciones. No repite
 *            identidad ni autonomía. Un `CLAUDE.md` que empieza con «Sos…» invade la capa 1.
 *   Capa 3 · memoria    → LO QUE ESE AGENTE APRENDIÓ. Ni identidad ni manual.
 *
 * El aviso NO bloquea nada: el punto 3 del diseño dice literalmente «no bloquear: avisar». Lo que
 * Steven teme no es que haya texto de más, es que la MISMA regla esté escrita en dos sitios y que,
 * cuando diverjan, nadie sepa cuál manda.
 *
 * REGLA DE HONESTIDAD, que es de donde salen la mitad de los defectos de esta consola: acá sólo se
 * emiten avisos sobre capas que SE LEYERON. Con el gateway sin publicar los ficheros, decir «este
 * alias no tiene CLAUDE.md» sería inventar un negativo que nadie midió. Ver `avisosDeCapas`.
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
 * Los giros con los que la flota escribe REALMENTE la autonomía y los permisos.
 *
 * Salen de leer los 14 briefs de producción, no de imaginar sinónimos: todos tienen la misma
 * forma «… AUTONOMIA: decidí y actuá vos. Pedí permiso SOLO si…». Se buscan giros, no palabras
 * sueltas, porque «permiso» a secas aparece en manuales legítimos («el fichero necesita permiso
 * de lectura») y marcarlo ahí sería un guardia que grita en falso.
 */
const GIROS_DE_AUTONOMIA: Array<{ patron: RegExp; etiqueta: string }> = [
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
 * `directiva.publicado === false` es el caso que más importa hacer bien: significa que los
 * ficheros NO SE MIRARON. Devuelve lista vacía a propósito —ni un «no tiene manual», ni un «no se
 * pisan»—, porque las dos frases serían afirmaciones sobre algo que nadie leyó. Quien pinta la
 * pantalla se encarga de decir que no se pudo mirar; ver `DirectivaTab`.
 */
export function avisosDeCapas(roleBrief: string | null | undefined, directiva: AgentDirective | undefined): AvisoDeCapas[] {
  if (!directiva?.publicado) return [];
  const ficheros = directiva.files ?? [];
  const avisos: AvisoDeCapas[] = [];

  const girosDelBrief = girosDeAutonomia(roleBrief);

  for (const fichero of ficheros) {
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

  if (ficheros.length > 1) {
    avisos.push({
      id: 'dos-manuales',
      tono: 'choque',
      titulo: `Este alias tiene ${ficheros.length} manuales a la vez`,
      detalle: 'Hay `CLAUDE.md` en más de un nivel (usuario y espacio de trabajo) y no está decidido '
        + 'cuál manda. Es el caso janus del diseño: hay que decir cuál gobierna, o quitar uno.',
      evidencia: ficheros.map(rotuloDeFichero),
    });
  }

  if (ficheros.length === 0) {
    avisos.push({
      id: 'sin-manual',
      tono: 'hueco',
      titulo: 'Ningún manual: este alias arranca sin contexto operativo',
      detalle: 'El servidor miró y no hay `CLAUDE.md` en ningún nivel. Es el caso gaia del diseño: '
        + 'el alta de un alias no siembra uno, así que el agente empieza sin saber cómo se trabaja acá.',
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
 * ¿La lectura de esta capa OCURRIÓ, y qué encontró?
 *
 * Esto existe porque la consola llegó a afirmar una ausencia que nadie había medido. El gateway
 * degrada bien —`{publicado: true, motivo: 'contenedor no medido todavía', files: null}`— pero
 * la columna sólo enseñaba el aviso cuando `publicado` era FALSO, así que ese motivo no se veía
 * nunca y en su lugar salía «miró el contenedor y no hay ningún CLAUDE.md». Medido el 24-ago-2026
 * dentro de los contenedores, eso era falso en 11 de los 12 alias que pude mirar.
 *
 * El discriminante correcto no es «¿publica el endpoint?». Es «¿ocurrió la lectura?»:
 *
 *   `null`      → NO se miró. Prohibido afirmar la ausencia; hay que enseñar el motivo.
 *   `[]` / `0`  → se miró y no hay. Ahí sí se puede afirmar.
 *
 * `medido` manda sobre todo lo demás para que un gateway que degrade rellenando listas vacías
 * —en vez de con `null`— tampoco pueda arrastrarnos a la afirmación. Los gateways viejos no
 * mandan ese campo: para ellos vale la regla del `null`, que es la que ya cumplían.
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
  const total = totalDeMemoria(recurso.data);
  if (total === undefined) return 'no-se-miro';
  return total === 0 ? 'miro-y-no-hay' : 'hay-datos';
}

/** Cuántas entradas de memoria hay DE VERDAD, aunque la lista venga recortada. */
export function totalDeMemoria(directiva: AgentDirective | undefined): number | undefined {
  const memoria = directiva?.memory;
  if (!memoria) return undefined;
  if (typeof memoria.total === 'number') return memoria.total;
  return Array.isArray(memoria.entries) ? memoria.entries.length : undefined;
}
