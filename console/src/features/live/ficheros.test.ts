import type { AgentDocumentItem, AgentDocumentsMap } from '../../api/types';
import {
  avisoAntesDeGuardar, avisoDeFuente, explicarFallo, hayCambios, mensajeDeGuardado,
  modoDeDocumento,
} from './ficheros';

function doc(extra: Partial<AgentDocumentItem> = {}): AgentDocumentItem {
  return {
    kind: 'directive',
    label: 'CLAUDE.md (manual del sitio)',
    path: '/home/dev/.claude/CLAUDE.md',
    format: 'markdown',
    editable: true,
    ...extra,
  };
}

describe('qué se puede hacer con cada fichero', () => {
  it('un fichero entero editable se edita entero', () => {
    expect(modoDeDocumento(doc())).toBe('entero');
  });

  /**
   * El caso de `openclaw.json`: NO es editable como fichero —lleva `auth` y `secrets`— pero sus
   * campos proyectados sí. Si esto se leyera como «sólo lectura», Steven perdería justamente lo
   * que pidió; si se leyera como «entero», la pantalla le enseñaría un documento incompleto
   * haciéndole creer que es el fichero completo, y al borrar de la vista borraría lo que no ve.
   */
  it('un fichero con campos proyectados es un tercer estado, ni entero ni cerrado', () => {
    const proyectado = doc({ editable: false, projected_fields: ['agents'] });
    expect(modoDeDocumento(proyectado)).toBe('proyectado');
  });

  it('sin editable y sin campos proyectados es sólo lectura', () => {
    const cerrado = doc({ editable: false, reason: 'vive con el OAuth' });
    expect(modoDeDocumento(cerrado)).toBe('solo-lectura');
  });

  /** Una lista vacía de campos NO es una proyección. Fallar cerrada también aquí. */
  it('projected_fields vacío no abre nada', () => {
    expect(modoDeDocumento(doc({ editable: false, projected_fields: [] }))).toBe('solo-lectura');
  });
});

describe('por qué no se puede — los cuatro motivos NO se pintan igual', () => {
  /**
   * Éste es el corazón del módulo. 409 y 503 se arreglan (midiendo, desplegando); 403 es una
   * decisión que no va a cambiar. Si los tres dieran `pendiente: true`, Steven esperaría a que
   * «se arregle» que su openclaw.json no se sirva entero, que está bien como está.
   */
  it('distingue lo que está pendiente de lo que es una decisión', () => {
    expect(explicarFallo(409).pendiente).toBe(true);
    expect(explicarFallo(503).pendiente).toBe(true);
    expect(explicarFallo(403).pendiente).toBe(false);
    expect(explicarFallo(404).pendiente).toBe(false);
    expect(explicarFallo(413).pendiente).toBe(false);
  });

  it('cada motivo tiene su propio titular', () => {
    const titulos = [409, 503, 403, 404, 413].map((s) => explicarFallo(s).titulo);
    expect(new Set(titulos).size).toBe(titulos.length);
  });

  /** La razón medida la redacta el gateway. Repetirla aquí sería tenerla en dos sitios. */
  it('cuando el servidor da una razón, se enseña la del servidor', () => {
    const razon = 'dentro de `skills` y de `mcp` hay claves de API vivas';
    expect(explicarFallo(403, razon).detalle).toBe(razon);
  });

  it('cuando el servidor no da razón, hay una por defecto y no una cadena vacía', () => {
    expect(explicarFallo(503).detalle.length).toBeGreaterThan(20);
    expect(explicarFallo(undefined).detalle.length).toBeGreaterThan(10);
  });
});

describe('el aviso de la cabecera', () => {
  const base: AgentDocumentsMap = {
    publicado: true, facts_source: 'measured', items: [],
  };

  /** Sin nada que advertir, NO se advierte. Un guardia que grita en falso acaba ignorado. */
  it('no inventa un aviso cuando las rutas SÍ están medidas', () => {
    expect(avisoDeFuente(base)).toBeUndefined();
  });

  it('cuando la fuente no es una medición, repite el aviso del servidor', () => {
    expect(avisoDeFuente({ ...base, facts_source: 'database', caveat: 'están deducidas' }))
      .toBe('están deducidas');
  });

  it('cuando el gateway no publica la ruta, el aviso es el motivo', () => {
    expect(avisoDeFuente({ publicado: false, motivo: 'respondió 404' })).toBe('respondió 404');
  });
});

describe('el aviso de antes de guardar', () => {
  it('un settings.json con hooks avisa de que eso ejecuta código', () => {
    const aviso = avisoAntesDeGuardar(doc({ kind: 'tools', warning: 'puede contener `hooks`' }));
    expect(aviso).toBe('puede contener `hooks`');
  });

  it('un documento proyectado avisa de que lo que se ve es una parte', () => {
    const aviso = avisoAntesDeGuardar(doc({ editable: false, projected_fields: ['agents'] }));
    expect(aviso).toMatch(/parte/i);
  });

  it('un CLAUDE.md corriente no lleva aviso', () => {
    expect(avisoAntesDeGuardar(doc())).toBeUndefined();
  });
});

describe('hay cambios sin guardar', () => {
  it('un espacio al final también es un cambio', () => {
    expect(hayCambios('hola', 'hola ')).toBe(true);
    expect(hayCambios('hola', 'hola')).toBe(false);
  });
});

describe('estado después de escribir', () => {
  it('dice aplicado sólo con evidencia explícita de la sonda', () => {
    const mensaje = mensajeDeGuardado({
      ok: true,
      state: 'applied',
      evidence: 'probe_write_ack',
      path: '/home/dev/.claude/CLAUDE.md',
      sha: 'a'.repeat(64),
      bytes: 12,
    });

    expect(mensaje).toMatch(/Aplicado/);
    expect(mensaje).toMatch(/ACK de escritura/);
  });

  it('CONTROL NEGATIVO: una respuesta legacy sin evidencia no inventa aplicación', () => {
    const legacy = {
      ok: true, path: '/home/dev/.claude/CLAUDE.md', sha: 'abc', bytes: 12,
    } as Parameters<typeof mensajeDeGuardado>[0];

    const mensaje = mensajeDeGuardado(legacy);

    expect(mensaje).toMatch(/no quedó confirmada/);
    expect(mensaje).not.toMatch(/^Aplicado/);
  });
});
