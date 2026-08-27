export interface ReglaCss {
  hoja: string;
  selector: string;
  cuerpo: string;
  media: string;
}

export function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function bloqueMedia(css: string, consulta: string): string {
  const limpio = sinComentarios(css);
  const inicio = limpio.indexOf(consulta);
  if (inicio < 0) return '';
  let cursor = limpio.indexOf('{', inicio);
  if (cursor < 0) return '';
  const desde = cursor + 1;
  let profundidad = 0;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}

export function bloquesDeModoClaro(css: string): string {
  const limpio = sinComentarios(css);
  const salida: string[] = [];
  const patron = /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)/g;
  let coincidencia: RegExpExecArray | null;
  while ((coincidencia = patron.exec(limpio))) {
    const cuerpo = bloqueMedia(limpio.slice(coincidencia.index), '@media');
    if (cuerpo) salida.push(cuerpo);
  }
  return salida.join('\n');
}

export function declaraciones(bloque: string, selector: string): string {
  const escapado = selector.replace(/[.[\]()="^$*+?|\\/{}-]/g, (c) => `\\${c}`);
  const patron = new RegExp(`(^|[{},])\\s*${escapado}\\s*\\{([^{}]*)\\}`, 'g');
  let salida = '';
  let encontrado: RegExpExecArray | null;
  while ((encontrado = patron.exec(bloque))) {
    salida += (salida ? ';' : '') + encontrado[2];
  }
  return salida;
}

export function declaracionesDeClase(css: string, clase: string): Record<string, string> {
  const limpio = sinComentarios(css);
  for (const regla of limpio.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectores = regla[1].split(',').map((parte) => parte.trim());
    if (!selectores.some((selector) => selector.split(/\s+/).some((parte) => parte === clase))) continue;
    const salida: Record<string, string> = {};
    for (const declaracion of regla[2].split(';')) {
      const corte = declaracion.indexOf(':');
      if (corte < 0) continue;
      salida[declaracion.slice(0, corte).trim()] = declaracion.slice(corte + 1).trim();
    }
    return salida;
  }
  return {};
}

export function valor(declaracion: string, propiedad: string): string | undefined {
  const patron = new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`, 'g');
  const coincidencias = [...declaracion.matchAll(patron)];
  return coincidencias.at(-1)?.[1]?.trim();
}

export function cuerposDeSelector(css: string, selector: string): string[] {
  const limpio = sinComentarios(css);
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patron = new RegExp(`(?:^|[{},;])\\s*${escapado}\\s*\\{([^}]*)\\}`, 'g');
  const salida: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = patron.exec(limpio))) salida.push(m[1]);
  return salida;
}

export function reglasDe(css: string, hoja = ''): ReglaCss[] {
  const limpio = sinComentarios(css);
  const salida: ReglaCss[] = [];
  const pila: string[] = [];
  let cabecera = '';
  let cursor = 0;
  while (cursor < limpio.length) {
    const caracter = limpio[cursor];
    if (caracter === '{') {
      const titulo = cabecera.trim();
      cabecera = '';
      if (titulo.startsWith('@')) {
        pila.push(titulo);
        cursor += 1;
        continue;
      }
      let profundidad = 1;
      let fin = cursor + 1;
      while (fin < limpio.length && profundidad > 0) {
        if (limpio[fin] === '{') profundidad += 1;
        else if (limpio[fin] === '}') profundidad -= 1;
        fin += 1;
      }
      salida.push({
        hoja,
        selector: titulo,
        cuerpo: limpio.slice(cursor + 1, fin - 1),
        media: pila.filter((p) => p.startsWith('@media')).join(' Y '),
      });
      cursor = fin;
      continue;
    }
    if (caracter === '}') pila.pop();
    else cabecera += caracter;
    cursor += 1;
  }
  return salida;
}
