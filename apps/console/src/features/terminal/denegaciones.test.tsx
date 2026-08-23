/**
 * **El control negativo del carril.**
 *
 * No basta con probar que `no_grant` hoy se ve en castellano: eso lo cumpliría un `if` suelto y
 * volvería a romperse con la próxima puerta que el gateway agregue. Lo que se prueba acá es la
 * INVARIANTE:
 *
 *  1. la tabla de castellano cubre EXACTAMENTE los códigos que el gateway declara — el fichero del
 *     gateway se LEE de disco, así que añadir un código allá y no acá hace fallar esta prueba;
 *  2. ninguno de esos códigos se le muestra crudo al operador en la vista `/terminal`, ni en el
 *     `[role=alert]` del diálogo ni en la línea de estado del canal;
 *  3. cada traducción dice las tres cosas: qué pasó, por qué, y quién puede levantar la puerta.
 *
 * Y el negativo de verdad: `la prueba FALLA si se borra la traducción`, más abajo, mete un código
 * inventado por el camino real y comprueba que la salida NO es la palabra cruda.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { TerminalPage } from './TerminalPage';
import {
  TERMINAL_DENIAL_CODES,
  TERMINAL_DENY_MESSAGES,
  codigoDeDenegacion,
  explicarDenegacionPty,
  traducirCodigosEnTexto,
  type TerminalDenialCode,
} from './denegaciones';

/** Sube desde este fichero hasta la raíz del repo, buscando `services/gateway`. */
function rutaDelGateway(): string {
  let directorio = dirname(fileURLToPath(import.meta.url));
  for (let salto = 0; salto < 10; salto += 1) {
    const candidato = join(directorio, 'services', 'gateway', 'src', 'terminal', 'types.ts');
    try {
      readFileSync(candidato, 'utf8');
      return candidato;
    } catch {
      directorio = dirname(directorio);
    }
  }
  throw new Error('No se encontró services/gateway/src/terminal/types.ts desde la consola');
}

/** Extrae los miembros de una unión de literales `export type X = 'a' | 'b';` */
function unionDelGateway(fuente: string, nombre: string): string[] {
  const bloque = new RegExp(`export type ${nombre}\\s*=([\\s\\S]*?);`).exec(fuente);
  if (!bloque) throw new Error(`No se encontró la unión ${nombre} en el gateway`);
  return [...bloque[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

describe('los códigos de denegación del gateway', () => {
  const fuente = readFileSync(rutaDelGateway(), 'utf8');
  const declarados = [
    ...unionDelGateway(fuente, 'TerminalDenial'),
    ...unionDelGateway(fuente, 'TerminalConflict'),
  ];

  it('el gateway declara los ocho que esta consola cree conocer (si no, alguien agregó una puerta)', () => {
    expect(declarados.length).toBeGreaterThanOrEqual(8);
    for (const codigo of declarados) {
      expect(
        TERMINAL_DENIAL_CODES,
        `El gateway emite «${codigo}» y esta consola no tiene castellano para él: `
        + 'añadilo a TERMINAL_DENY_MESSAGES en denegaciones.ts.',
      ).toContain(codigo);
    }
  });

  it('no sobra ninguno: cada traducción corresponde a un código real del gateway o del inventario', () => {
    // `not_installed` no es del gateway sino del inventario de destinos (`PtyState`); se admite
    // explícitamente para que la lista no crezca con códigos que ya nadie emite.
    const admitidos = new Set([...declarados, 'not_installed']);
    for (const codigo of TERMINAL_DENIAL_CODES) expect(admitidos).toContain(codigo);
  });

  it.each(TERMINAL_DENIAL_CODES)('«%s» dice qué pasó, por qué y quién lo levanta — en castellano', (codigo) => {
    const copia = TERMINAL_DENY_MESSAGES[codigo];
    for (const [campo, texto] of Object.entries(copia)) {
      expect(texto.length, `${codigo}.${campo} está vacío`).toBeGreaterThan(20);
      // Ni el titular ni el motivo ni el responsable pueden contener el código crudo.
      expect(texto, `${codigo}.${campo} repite el código crudo`).not.toContain(codigo);
      // Ningún identificador crudo, de NINGÚN código: `snake_case` es exactamente la forma que
      // tiene lo que sale de la base y del protocolo, y es lo que no puede llegar a la pantalla.
      expect(texto, `${codigo}.${campo} contiene un identificador crudo`).not.toMatch(/\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/);
    }
  });

  it.each(TERMINAL_DENIAL_CODES)('«%s» se explica sin devolver nunca la palabra cruda', (codigo) => {
    const explicada = explicarDenegacionPty({ texto: codigo, estado: 403 });
    expect(explicada.codigo).toBe(codigo);
    expect(explicada.titulo).not.toContain(codigo);
    expect(explicada.linea).not.toContain(codigo);
    expect(explicada.linea).toContain('Lo levanta:');
    expect(explicada.porQue).toContain('HTTP 403');
  });

  it.each(TERMINAL_DENIAL_CODES)('«%s» también se reconoce embebido en la prosa del inventario', (codigo) => {
    const prosa = `${codigo}: falta identidad por persona.`;
    expect(codigoDeDenegacion(prosa)).toBe(codigo);
    const traducido = traducirCodigosEnTexto(prosa);
    expect(traducido).not.toContain(codigo);
    expect(traducido).toContain('Lo levanta:');
  });

  it('un código que esta consola NO conoce se CITA, no se traduce a la ligera', () => {
    const explicada = explicarDenegacionPty({ texto: 'puerta_nueva_del_futuro', estado: 403 });
    expect(explicada.codigo).toBeUndefined();
    expect(explicada.porQue).toContain('puerta_nueva_del_futuro');
    expect(explicada.porQue).toContain('no tiene traducción');
    expect(explicada.titulo).not.toContain('puerta_nueva_del_futuro');
  });

  it('un texto sin ningún código se devuelve intacto: no se toca lo que ya estaba bien', () => {
    const bueno = 'El servidor no informó un motivo para este destino.';
    expect(traducirCodigosEnTexto(bueno)).toBe(bueno);
  });
});

/* ---------------------------------------------------------------------------------------------
 * El mismo control, pero contra el DOM: la tabla de arriba probaría igual de bien un módulo que
 * nadie llama. Esto recorre los códigos por el camino real —el POST que rechaza el gateway— y
 * exige que la palabra cruda no llegue nunca a la pantalla.
 * ------------------------------------------------------------------------------------------- */

const AGENTE = { tenant_id: 'Steven', alias: 'zeus' };

function servirCapacidad() {
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true,
      plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'],
      websocket_path: '/v3/console/terminal/socket',
      target_label: 'Steven:zeus',
      reason: 'Relay disponible.',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(),
      websocket_path: '/v3/console/terminal/socket',
      items: [{
        ...AGENTE,
        container: 'claw-zeus',
        runtime_user: 'dev',
        harness: 'claude',
        shares_container_with: [],
        modes: ['shell', 'harness'],
        pty_state: 'online',
        last_seen: new Date().toISOString(),
        authorized: true,
        reason: 'Autorizado por el servidor.',
      }],
    })),
  );
}

describe('la negativa que ve el operador', () => {
  it.each([
    ['no_grant', 403],
    ['attribution_required', 403],
    ['control_permission_required', 403],
    ['no_routing_authority', 403],
    ['unknown_alias', 403],
    ['agent_offline', 409],
    ['session_limit', 409],
    ['container_busy', 409],
  ] as Array<[TerminalDenialCode, number]>)(
    'un %s del gateway NO se muestra crudo: se dice qué pasó y quién lo levanta',
    async (codigo, estado) => {
      servirCapacidad();
      server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
        { error: estado === 403 ? 'forbidden' : 'conflict', reason: codigo },
        { status: estado },
      )));

      renderWithApi(<TerminalPage />);
      const boton = await screen.findByRole('button', { name: /Abrir sesión con zeus/i }, { timeout: 5000 });
      await userEvent.click(boton);

      // La apertura automática de la TUI ya golpea el gateway y recibe el rechazo.
      const aviso = await waitFor(() => {
        const encontrados = screen.getAllByRole('alert');
        const conTexto = encontrados.find((nodo) => (nodo.textContent ?? '').includes('Lo levanta:'));
        expect(conTexto).toBeDefined();
        return conTexto!;
      }, { timeout: 6000 });

      const copia = TERMINAL_DENY_MESSAGES[codigo];
      expect(aviso.textContent).toContain(copia.titulo);
      expect(aviso.textContent).toContain('Lo levanta:');
      expect(aviso.textContent).toContain(`HTTP ${estado}`);
      // 🔴 El control negativo: la palabra cruda NO puede estar en ningún sitio de la pantalla.
      expect(document.body.textContent).not.toContain(codigo);
    },
  );

  it('la prosa del inventario tampoco llega cruda a la línea de estado del canal', async () => {
    server.use(
      http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
        available: true,
        plugin_id: 'ultimate-terminal.client',
        capabilities: ['terminal.pty.client'],
        websocket_path: '/v3/console/terminal/socket',
        reason: 'Relay disponible.',
      })),
      http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
        observed_at: new Date().toISOString(),
        websocket_path: '/v3/console/terminal/socket',
        items: [{
          ...AGENTE,
          container: null,
          runtime_user: null,
          harness: null,
          shares_container_with: [],
          modes: [],
          pty_state: 'unknown',
          last_seen: null,
          authorized: false,
          reason: 'attribution_required: falta identidad por persona.',
        }],
      })),
    );

    renderWithApi(<TerminalPage />);
    const boton = await screen.findByRole('button', { name: /Abrir sesión con zeus/i }, { timeout: 5000 });
    await userEvent.click(boton);

    const panel = await screen.findByRole('tabpanel', {}, { timeout: 5000 });
    await waitFor(() => {
      expect(within(panel).getByText(new RegExp(TERMINAL_DENY_MESSAGES.attribution_required.titulo, 'i'))).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(document.body.textContent).not.toContain('attribution_required');
  });
});
