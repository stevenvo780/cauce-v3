import type { QueueItem } from '../../api/types';
import { enfocarEntrega, leerEntregaPedida } from './foco-de-entrega';

const filas: QueueItem[] = [
  { delivery_id: 'delivery-a', state: 'dead' },
  { delivery_id: 'delivery-b', state: 'retry' },
  { delivery_id: null, state: 'pending' },
];

describe('leerEntregaPedida', () => {
  it.each([
    ['?delivery=delivery-a', 'delivery-a'],
    ['delivery=delivery-a', 'delivery-a'],
    ['?delivery=delivery-a&otra=1', 'delivery-a'],
    ['?delivery=%20delivery-a%20', 'delivery-a'],
  ])('lee %s como %s', (search, esperado) => {
    expect(leerEntregaPedida(search)).toBe(esperado);
  });

  it.each([
    ['', 'sin query'],
    ['?agente=Steven%2Fzeus&pestana=entregas', 'la query del cajón de la flota, que no pide entrega'],
    ['?delivery=', 'el parámetro vacío que produce `item.delivery_id ?? \'\'` cuando la entrega no tiene id'],
    ['?delivery=%20%20', 'sólo espacios'],
  ])('no pide ninguna entrega con %s (%s)', (search) => {
    expect(leerEntregaPedida(search)).toBeUndefined();
  });
});

describe('enfocarEntrega', () => {
  it('sin foco devuelve la lista entera, sin tocarla', () => {
    const foco = enfocarEntrega(filas, undefined);
    expect(foco.estado).toBe('sin-foco');
    expect(foco.filas).toEqual(filas);
    expect(foco.deliveryId).toBeUndefined();
  });

  it('con la entrega presente filtra a esa sola fila y conserva el id pedido', () => {
    const foco = enfocarEntrega(filas, 'delivery-b');
    expect(foco.estado).toBe('encontrada');
    expect(foco.deliveryId).toBe('delivery-b');
    expect(foco.filas).toEqual([{ delivery_id: 'delivery-b', state: 'retry' }]);
  });

  it('con la entrega ausente NO devuelve la lista genérica: devuelve cero filas y lo declara', () => {
    const foco = enfocarEntrega(filas, 'delivery-que-no-esta');
    expect(foco.estado).toBe('ausente');
    expect(foco.deliveryId).toBe('delivery-que-no-esta');
    expect(foco.filas).toEqual([]);
  });

  it('una fila sin delivery_id nunca se confunde con la pedida', () => {
    expect(enfocarEntrega(filas, 'null').estado).toBe('ausente');
    expect(enfocarEntrega(filas, 'undefined').estado).toBe('ausente');
  });
});
