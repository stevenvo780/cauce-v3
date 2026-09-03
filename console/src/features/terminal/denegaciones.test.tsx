/**
 * **The negative control of the lane.**
 *
 * It is not enough to prove that `no_grant` is seen in Spanish today: a loose `if` would
 * satisfy that, and it would break again the next time the gateway adds a door. What is
 * proven here is the INVARIANT:
 *
 *  1. the Spanish table covers EXACTLY the codes the gateway declares — the gateway file is
 *     READ from disk, so adding a code there and not here makes this test fail;
 *  2. none of those codes is shown raw to the operator in the `/terminal` view, neither in
 *     the dialog `[role=alert]` nor in the channel status line;
 *  3. each translation says three things: what happened, why, and who can lift the door.
 *
 * And the real negative: "the test FAILS if the translation is deleted", below, feeds a
 * bogus code through the real path and checks that the output is NOT the raw word.
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

/** Goes up from this file to the repo root, looking for `services/gateway`. */
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

/** Extracts the members of a literal union `export type X = 'a' | 'b';` */
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

  it('el gateway declara los doce que esta consola cree conocer (si no, alguien agregó una puerta)', () => {
    expect(declarados.length).toBeGreaterThanOrEqual(12);
    for (const codigo of declarados) {
      expect(
        TERMINAL_DENIAL_CODES,
        `El gateway emite «${codigo}» y esta consola no tiene castellano para él: `
        + 'añadilo a TERMINAL_DENY_MESSAGES en denegaciones.ts.',
      ).toContain(codigo);
    }
  });

  it('no sobra ninguno: cada traducción corresponde a un código real del gateway o del inventario', () => {
    // Three do not come out of the gateway denials union and are admitted one by one, so the
    // list does not grow with codes nobody emits anymore:
    //  - `not_installed` comes from the targets inventory (`PtyState`);
    //  - `csrf_missing` is not a gateway door but a bug in THIS console — the write went out
    //    without `X-CSRF-Token` and the gateway rejected it before checking the permission —
    //    and is recognized by the 403 prose, not by an identifier;
    //  - `unauthorized` is the console cookie expired, which is not an operator permission either.
    // All three must be here and not in a second translator: one vocabulary for the negatives
    // of the PTY plane.
    const admitidos = new Set([...declarados, 'not_installed', 'csrf_missing', 'unauthorized']);
    for (const codigo of TERMINAL_DENIAL_CODES) expect(admitidos).toContain(codigo);
  });

  it.each(TERMINAL_DENIAL_CODES)('"%s" says what happened, why, and who lifts it — in Spanish', (codigo) => {
    const copia = TERMINAL_DENY_MESSAGES[codigo];
    for (const [campo, texto] of Object.entries(copia) as [string, string][]) {
      expect(texto.length, `${codigo}.${campo} is empty`).toBeGreaterThan(20);
      // Neither the title nor the reason nor the one-who-lifts-it may contain the raw code.
      expect(texto, `${codigo}.${campo} repeats the raw code`).not.toContain(codigo);
      // No raw identifier of ANY code: `snake_case` is exactly the shape of what comes out of
      // the database and the protocol, and is what must never reach the screen.
      expect(texto, `${codigo}.${campo} contains a raw identifier`).not.toMatch(/\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/);
    }
  });

  it.each(TERMINAL_DENIAL_CODES)('"%s" is explained without ever returning the raw word', (codigo) => {
    const explicada = explicarDenegacionPty({ texto: codigo, estado: 403 });
    expect(explicada.codigo).toBe(codigo);
    expect(explicada.titulo).not.toContain(codigo);
    expect(explicada.linea).not.toContain(codigo);
    expect(explicada.linea).toContain('Lo levanta:');
    expect(explicada.porQue).toContain('HTTP 403');
  });

  it.each(TERMINAL_DENIAL_CODES)('"%s" is also recognized embedded in the inventory prose', (codigo) => {
    const prosa = `${codigo}: falta identidad por persona.`;
    expect(codigoDeDenegacion(prosa)).toBe(codigo);
    const traducido = traducirCodigosEnTexto(prosa);
    expect(traducido).not.toContain(codigo);
    expect(traducido).toContain('Lo levanta:');
  });

  it('a code this console does NOT know is QUOTED, not loosely translated', () => {
    const explicada = explicarDenegacionPty({ texto: 'puerta_nueva_del_futuro', estado: 403 });
    expect(explicada.codigo).toBeUndefined();
    expect(explicada.porQue).toContain('puerta_nueva_del_futuro');
    expect(explicada.porQue).toContain('no tiene traducción');
    expect(explicada.titulo).not.toContain('puerta_nueva_del_futuro');
  });

  it('a text with no code is returned intact: what was already right is not touched', () => {
    const bueno = 'El servidor no informó un motivo para este destino.';
    expect(traducirCodigosEnTexto(bueno)).toBe(bueno);
  });
});

/* ---------------------------------------------------------------------------------------------
 * The same control, but against the DOM: the table above would test just as well a module that
 * nobody calls. This walks the codes through the real path — the POST the gateway rejects — and
 * requires the raw word to never reach the screen.
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
  ] as [TerminalDenialCode, number][])(
    'a gateway %s is NOT shown raw: it says what happened and who lifts it',
    async (codigo, estado) => {
      servirCapacidad();
      server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
        { error: estado === 403 ? 'forbidden' : 'conflict', reason: codigo },
        { status: estado },
      )));

      renderWithApi(<TerminalPage />);
      const boton = await screen.findByRole('button', { name: /Abrir sesión con zeus/i }, { timeout: 5000 });
      await userEvent.click(boton);

      // The auto-open of the TUI already hits the gateway and gets the rejection.
      const aviso = await waitFor(() => {
        const encontrados = screen.getAllByRole('alert');
        const conTexto = encontrados.find((nodo) => nodo.textContent.includes('Lo levanta:'));
        expect(conTexto).toBeDefined();
        if (!conTexto) throw new Error('Aviso no encontrado');
        return conTexto;
      }, { timeout: 6000 });

      const copia = TERMINAL_DENY_MESSAGES[codigo];
      expect(aviso.textContent).toContain(copia.titulo);
      expect(aviso.textContent).toContain('Lo levanta:');
      expect(aviso.textContent).toContain(`HTTP ${String(estado)}`);
      // Negative control: the raw word CANNOT be anywhere on the screen.
      expect(document.body.textContent).not.toContain(codigo);
    },
  );

  it('the inventory prose does not reach the channel status line either', async () => {
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

/**
 * The four cases that `terminalSessionRefusal` (`session.ts`) used to bring — it was a SECOND
 * translator of the same 403 and was retired in the merge on 2026-08-23. The function is gone;
 * what it guaranteed stays, pointing at the translator that survived.
 */
describe('el rechazo al abrir la sesión, por el único traductor que queda', () => {
  function fallo(texto: string, estado: number, codigo?: string) {
    return explicarDenegacionPty({ texto, estado, codigo });
  }

  it('the 403 for CSRF is a CONSOLE bug, not an operator permission failure', () => {
    const negativa = fallo('se requiere un token CSRF válido', 403, 'forbidden');
    expect(negativa.codigo).toBe('csrf_missing');
    expect(negativa.esDefectoDeLaConsola).toBe(true);
    expect(negativa.porQue).toMatch(/no es tu permiso ni el alias/i);
    expect(negativa.quienLoLevanta).toMatch(/quien mantiene la consola/i);
  });

  it('a 403 that is NOT from CSRF is translated and does NOT accuse the console', () => {
    const negativa = fallo('attribution_required', 403, 'forbidden');
    expect(negativa.esDefectoDeLaConsola).toBeUndefined();
    expect(negativa.linea).not.toContain('attribution_required');
    expect(negativa.linea).toContain('403');
  });

  it('distinguishes the 409 of the destination from the 401 of the session', () => {
    const conflicto = fallo('agent_offline', 409, 'conflict');
    expect(conflicto.linea).toContain('409');
    expect(conflicto.linea).not.toContain('agent_offline');
    expect(fallo('unauthorized', 401, 'unauthorized').titulo).toMatch(/caducó/i);
  });

  it('an error without status does not invent a cause: it quotes what it knows', () => {
    const negativa = explicarDenegacionPty({ texto: 'Failed to fetch' });
    expect(negativa.esDefectoDeLaConsola).toBeUndefined();
    expect(negativa.porQue).toContain('Failed to fetch');
    expect(negativa.porQue).toMatch(/no tiene traducción para eso/i);
  });
});
