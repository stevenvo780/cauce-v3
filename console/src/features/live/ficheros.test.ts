import type { AgentDocumentItem, AgentDocumentsMap } from '../../api/types';
import {
  avisoAntesDeGuardar, avisoDeFuente, esAckAplicado, explicarFallo, hayCambios,
  mensajeDeGuardado, modoDeDocumento, preserveSourceLineEndings,
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
   * The `openclaw.json` case: it is NOT editable as a file — it carries `auth` and `secrets` —
   * but its projected fields are. If this read as "read only", the operator would lose exactly
   * what they asked for; if it read as "whole", the screen would show them an incomplete
   * document making them believe it was the full file, and deleting from the view would delete
   * what they cannot see.
   */
  it('un fichero con campos proyectados es un tercer estado, ni entero ni cerrado', () => {
    const proyectado = doc({ editable: false, projected_fields: ['agents'] });
    expect(modoDeDocumento(proyectado)).toBe('proyectado');
  });

  it('sin editable y sin campos proyectados es sólo lectura', () => {
    const cerrado = doc({ editable: false, reason: 'vive con el OAuth' });
    expect(modoDeDocumento(cerrado)).toBe('solo-lectura');
  });

  /** An empty field list is NOT a projection. Fail closed here too. */
  it('projected_fields vacío no abre nada', () => {
    expect(modoDeDocumento(doc({ editable: false, projected_fields: [] }))).toBe('solo-lectura');
  });
});

describe('por qué no se puede — los cuatro motivos NO se pintan igual', () => {
  /**
   * This is the heart of the module. 409 and 503 are fixed (by measuring, by deploying); 403 is
   * a decision that will not change. If all three returned `pendiente: true`, the operator
   * would wait for openclaw.json to "be fixed" to not be served whole, which is fine as it is.
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

  /** The measured reason is drafted by the gateway. Repeating it here would mean having it in two places. */
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

  /** With nothing to warn about, do NOT warn. A guard that screams false ends up ignored. */
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

  it('restaura CRLF cuando el textarea normaliza los saltos a LF', () => {
    expect(preserveSourceLineEndings('uno\r\ndos\r\n', 'uno\ndos editado\n'))
      .toBe('uno\r\ndos editado\r\n');
    expect(preserveSourceLineEndings('uno\ndos\n', 'uno\ndos editado\n'))
      .toBe('uno\ndos editado\n');
  });
});

describe('estado después de escribir', () => {
  const ACK = {
    ok: true,
    evidence: 'probe_write_ack',
    path: '/home/dev/.claude/CLAUDE.md',
    sha: 'a'.repeat(64),
    bytes: 12,
  } as const;

  it('dice aplicado sólo con evidencia explícita de adopción de la sesión', () => {
    const mensaje = mensajeDeGuardado({ ...ACK, state: 'applied' });

    expect(mensaje).toMatch(/Aplicado/);
    expect(mensaje).toMatch(/ACK de escritura/);
    expect(esAckAplicado({ ...ACK, state: 'applied' })).toBe(true);
  });

  it('un 202 written_pending_session es un guardado, y lo dice sin afirmar aplicación', () => {
    const resultado = { ...ACK, state: 'written_pending_session' };

    expect(esAckAplicado(resultado)).toBe(true);
    const mensaje = mensajeDeGuardado(resultado);
    expect(mensaje).toMatch(/^Escrito en/);
    expect(mensaje).toMatch(/recargar/);
    expect(mensaje).not.toMatch(/Aplicado/);
    expect(mensaje).not.toMatch(/no quedó confirmada/);
  });

  it('CONTROL NEGATIVO: una respuesta legacy sin evidencia no inventa aplicación', () => {
    const legacy = {
      ok: true, path: '/home/dev/.claude/CLAUDE.md', sha: 'abc', bytes: 12,
    } as Parameters<typeof mensajeDeGuardado>[0];

    const mensaje = mensajeDeGuardado(legacy);

    expect(esAckAplicado(legacy)).toBe(false);
    expect(mensaje).toMatch(/no quedó confirmada/);
    expect(mensaje).not.toMatch(/^Aplicado/);
    expect(mensaje).not.toMatch(/^Escrito/);
  });

  it('CONTROL NEGATIVO: un estado de otro vocabulario no acredita nada', () => {
    const ajeno = { ...ACK, state: 'done' } as Parameters<typeof mensajeDeGuardado>[0];

    expect(esAckAplicado(ajeno)).toBe(false);
    expect(mensajeDeGuardado(ajeno)).toMatch(/no quedó confirmada/);
  });
});
