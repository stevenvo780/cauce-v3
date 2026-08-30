import { vi, describe, expect, it, beforeEach } from 'vitest';
const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

import { HttpGovernanceRelayClient, opcionesBase, prepararRespuesta, RUTA, TOKEN, setHttpsRequestMock } from './gateway-relay-governance-client-fixtures.js';

describe('constantes y opciones que el cliente pasa a https.request', () => {
  beforeEach(() => { httpsRequest.mockReset(); setHttpsRequestMock(httpsRequest); });
  it('usa el timeout por defecto de 10_000 ms cuando no se pasa timeoutMs', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const calls = handles.reqOnCalls();
    const setTimeoutMock = httpsRequest.mock.results[0]?.value as { setTimeout: ReturnType<typeof vi.fn> };
    void calls;
    expect(setTimeoutMock.setTimeout).toHaveBeenCalledWith(10_000, expect.any(Function));
  });

  it('usa el timeout configurado cuando se pasa timeoutMs', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ timeoutMs: 2_500 }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const setTimeoutMock = httpsRequest.mock.results[0]?.value as { setTimeout: ReturnType<typeof vi.fn> };
    void handles;
    expect(setTimeoutMock.setTimeout).toHaveBeenCalledWith(2_500, expect.any(Function));
  });

  it('incluye ca, cert y key en las opciones cuando se pasa material mTLS', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const ca = Buffer.from('ca-bytes');
    const cert = Buffer.from('cert-bytes');
    const key = Buffer.from('key-bytes');
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ ca, clientCert: cert, clientKey: key }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const captured = handles.captured();
    expect(captured).toBeDefined();
    expect(captured?.options.ca).toBe(ca);
    expect(captured?.options.cert).toBe(cert);
    expect(captured?.options.key).toBe(key);
  });

  it('omite ca/cert/key cuando no se pasa material mTLS (no los manda como undefined)', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const captured = handles.captured();
    expect(captured).toBeDefined();
    expect(captured?.options).not.toHaveProperty('ca');
    expect(captured?.options).not.toHaveProperty('cert');
    expect(captured?.options).not.toHaveProperty('key');
  });

  it('pasa el AbortSignal al request para que el agente de abajo pueda abortar el socket', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const controller = new AbortController();
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA, controller.signal);

    const captured = handles.captured();
    expect(captured?.options.signal).toBe(controller.signal);
  });

  it('omite signal cuando no se pasa AbortSignal', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    expect(handles.captured()?.options).not.toHaveProperty('signal');
  });

  it('manda Bearer token, content-type application/json y content-length exacto', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const headers = handles.captured()?.options.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.accept).toBe('application/json');
    expect(headers['content-type']).toBe('application/json');
    const payload = Buffer.from(JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: RUTA }), 'utf8');
    expect(Number(headers['content-length'])).toBe(payload.byteLength);
  });

  it('construye la URL pegando la ruta al relayUrl', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ relayUrl: 'https://relay.local:8443/' }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/read');
    expect(url.host).toBe('relay.local:8443');
    expect(url.protocol).toBe('https:');
  });
});
