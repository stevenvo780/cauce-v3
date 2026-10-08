import { prorrogarSesion, devolverControlDeTui, tomarControlDeTui } from '../features/terminal/api-control';
import { testApi } from '../test/render';
import { server } from './server';
import { terminalDemoHandlers } from './terminal-demo';

const OWNER = {
  request_id: '11111111-1111-4111-8111-111111111111',
  owner_generation: '1',
  owner_token: '22222222-2222-4222-8222-222222222222',
  authority_proof: 'ac2.prueba.firma',
};

beforeEach(() => { server.use(...terminalDemoHandlers); });

it('el banco de pruebas atiende tomar el control de la TUI con un recibo que la consola da por limpio', async () => {
  const recibo = await tomarControlDeTui('demo-1', OWNER, testApi);

  expect(recibo.dudoso).toEqual([]);
  expect(recibo).toMatchObject({ session_id: 'demo-1', held_by: 'Steven:kant' });
  expect(Date.parse(recibo.expires_at ?? '')).toBeGreaterThan(Date.now());
});

it('el banco de pruebas atiende devolver el control y prorrogar la ventana de la sesión', async () => {
  await expect(devolverControlDeTui('demo-1', OWNER, testApi)).resolves.toMatchObject({ session_id: 'demo-1' });
  const prorroga = await prorrogarSesion('demo-1', OWNER, testApi);

  expect(prorroga.request_id).toBe(OWNER.request_id);
  expect(Date.parse(prorroga.expires_at)).toBeGreaterThan(Date.now());
});
