import type { AgentDocumentItem } from '../../api/types';
import {
  avisoAntesDeGuardar, esAckAplicado, hayCambios, mensajeDeGuardado,
  modoDeDocumento, preserveSourceLineEndings,
} from './ficheros';
import {
  DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN, explicarFalloDeMotivo, problemaDeMotivo,
} from './ficheros-motivo';
import { MENSAJES_DE_APLICACION } from './perfil';

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

  it('sin editable y sin campos proyectados es solo lectura', () => {
    const cerrado = doc({ editable: false, reason: 'vive con el OAuth' });
    expect(modoDeDocumento(cerrado)).toBe('solo-lectura');
  });
});

describe('el aviso de antes de guardar', () => {
  it('un settings.json con hooks avisa de que eso ejecuta código', () => {
    const aviso = avisoAntesDeGuardar(doc({ kind: 'tools', warning: 'puede contener `hooks`' }));
    expect(aviso).toBe('puede contener `hooks`');
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

  it('dice aplicado solo con evidencia explícita de adopción de la sesión', () => {
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
    expect(mensaje).not.toMatch(/Aplicado/);
    expect(mensaje).not.toMatch(/no confirmó por completo/);
    expect(mensaje).not.toContain(MENSAJES_DE_APLICACION.written_pending_session);
    expect(mensaje).not.toMatch(/recarg/);
  });

  it('CONTROL NEGATIVO: una respuesta legacy sin evidencia no inventa aplicación', () => {
    const legacy = {
      ok: true, path: '/home/dev/.claude/CLAUDE.md', sha: 'abc', bytes: 12,
    } as Parameters<typeof mensajeDeGuardado>[0];

    const mensaje = mensajeDeGuardado(legacy);

    expect(esAckAplicado(legacy)).toBe(false);
    expect(mensaje).toMatch(/no confirmó por completo/);
    expect(mensaje).not.toMatch(/^Aplicado/);
    expect(mensaje).not.toMatch(/^Escrito/);
  });

  it('CONTROL NEGATIVO: un estado de otro vocabulario no acredita nada', () => {
    const ajeno = { ...ACK, state: 'done' } as Parameters<typeof mensajeDeGuardado>[0];

    expect(esAckAplicado(ajeno)).toBe(false);
    expect(mensajeDeGuardado(ajeno)).toMatch(/no confirmó por completo/);
  });
});

describe('el motivo escrito a mano que exige la auditoría', () => {

  it('un motivo por debajo del mínimo no vale, y dice cuánto lleva', () => {
    const problema = problemaDeMotivo('corto');
    expect(problema).toMatch(new RegExp(String(DOCUMENT_REASON_MIN)));
    expect(problema).toMatch(/lleva 5/);
  });

  it('los espacios no cuentan: un motivo en blanco es un motivo ausente', () => {
    expect(problemaDeMotivo('          ')).toBeDefined();
    expect(problemaDeMotivo('   corrijo la ruta del manual   ')).toBeUndefined();
  });

  it('justo en el mínimo vale y justo por encima del máximo no', () => {
    expect(problemaDeMotivo('a'.repeat(DOCUMENT_REASON_MIN))).toBeUndefined();
    expect(problemaDeMotivo('a'.repeat(DOCUMENT_REASON_MAX))).toBeUndefined();
    expect(problemaDeMotivo('a'.repeat(DOCUMENT_REASON_MAX + 1)))
      .toMatch(new RegExp(String(DOCUMENT_REASON_MAX)));
  });
});

describe('las dos negativas que solo existen al guardar', () => {
  it('una sesión sin persona no se pinta como avería de ruta: dice qué hacer', () => {
    const explicado = explicarFalloDeMotivo(
      403, 'writable_requires_attribution', 'escribir la gobernanza exige una persona con nombre',
    );

    expect(explicado?.titulo).toMatch(/persona/i);
    expect(explicado?.detalle).toMatch(/exige una persona con nombre/);
    expect(explicado?.detalle).toMatch(/borrador se conserva/i);
    expect(explicado?.pendiente).toBe(true);
  });

  it('CONTROL NEGATIVO: un 403 de la política de rutas NO se disfraza de falta de persona', () => {
    expect(explicarFalloDeMotivo(403, 'forbidden', 'mezcla configuración con credenciales'))
      .toBeUndefined();
    expect(explicarFalloDeMotivo(409, 'conflict')).toBeUndefined();
    expect(explicarFalloDeMotivo(undefined, undefined)).toBeUndefined();
  });
});
