import { describe, expect, it, vi } from 'vitest';
import { estaPegadoAlFinal, irAlFinal, MARGEN_PEGADO } from './desplazamiento';

describe('cuándo un hilo está mirando el final', () => {
  it('está pegado cuando el fondo se ve entero', () => {
    expect(estaPegadoAlFinal({ scrollTop: 10_499, scrollHeight: 10_976, clientHeight: 477 })).toBe(true);
  });

  it('sigue pegado dentro del margen: unos píxeles no son «se fue a leer arriba»', () => {
    expect(estaPegadoAlFinal({
      scrollTop: 10_499 - MARGEN_PEGADO, scrollHeight: 10_976, clientHeight: 477,
    })).toBe(true);
  });

  /**
   * El caso que importa: el operador subió a leer. A partir de acá los mensajes nuevos NO pueden
   * arrastrarlo, o la vista le mueve el texto de debajo del ojo cada 2,5 segundos —que es cada
   * cuánto releen los mensajes—.
   */
  it('deja de estar pegado en cuanto el operador sube más que el margen', () => {
    expect(estaPegadoAlFinal({
      scrollTop: 10_499 - MARGEN_PEGADO - 1, scrollHeight: 10_976, clientHeight: 477,
    })).toBe(false);
    // Y el caso medido en producción: recién abierto, arriba del todo, a 10.976 px del final.
    expect(estaPegadoAlFinal({ scrollTop: 0, scrollHeight: 10_976, clientHeight: 477 })).toBe(false);
  });

  it('un hilo que cabe entero está pegado: no hay «final» al que ir', () => {
    expect(estaPegadoAlFinal({ scrollTop: 0, scrollHeight: 300, clientHeight: 477 })).toBe(true);
  });
});

describe('irAlFinal', () => {
  it('usa scrollTo cuando existe, que es lo que hace el navegador', () => {
    const scrollTo = vi.fn();
    const caja = { scrollHeight: 10_976, scrollTop: 0, scrollTo } as unknown as HTMLElement;
    irAlFinal(caja);
    expect(scrollTo).toHaveBeenCalledWith({ top: 10_976, behavior: 'auto' });
  });

  it('cae a scrollTop donde no hay scrollTo, para no quedarse sin hacer nada', () => {
    const caja = { scrollHeight: 10_976, scrollTop: 0 } as unknown as HTMLElement;
    irAlFinal(caja);
    expect(caja.scrollTop).toBe(10_976);
  });

  it('el botón «ir al último» pide desplazamiento suave; el arranque, no', () => {
    const scrollTo = vi.fn();
    const caja = { scrollHeight: 500, scrollTop: 0, scrollTo } as unknown as HTMLElement;
    irAlFinal(caja, true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
  });
});
