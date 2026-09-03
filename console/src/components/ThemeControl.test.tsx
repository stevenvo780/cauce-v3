import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAVE_TEMA, ThemeControl } from './ThemeControl';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.removeItem(CLAVE_TEMA);
  vi.restoreAllMocks();
});

const boton = (nombre: string) => screen.getByRole('button', { name: nombre });

describe('el control de tema de tres estados', () => {
  it('abre en «sistema» y NO estampa atributo: el sistema decide', () => {
    render(<ThemeControl />);

    expect(screen.getByRole('group', { name: /tema de la consola/i })).toBeInTheDocument();
    expect(boton('Sistema')).toHaveAttribute('aria-pressed', 'true');
    expect(boton('Claro')).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it.each([['Claro', 'light'], ['Oscuro', 'dark']])('«%s» estampa data-theme="%s"', async (rotulo, valor) => {
    render(<ThemeControl />);
    await userEvent.click(boton(rotulo));

    expect(document.documentElement.getAttribute('data-theme')).toBe(valor);
    expect(boton(rotulo)).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(CLAVE_TEMA)).toBe(rotulo.toLowerCase());
  });

  it('la elección sobrevive a un remontaje, que es lo que hace una recarga', async () => {
    render(<ThemeControl />);
    await userEvent.click(boton('Oscuro'));
    cleanup();
    document.documentElement.removeAttribute('data-theme');

    render(<ThemeControl />);

    expect(boton('Oscuro')).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('volver a «sistema» QUITA el atributo en vez de escribir un tema', async () => {
    render(<ThemeControl />);
    await userEvent.click(boton('Claro'));
    await userEvent.click(boton('Sistema'));

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(CLAVE_TEMA)).toBe('sistema');
  });

  it('una ventana privada lanza en cada acceso y aun así el control pinta y funciona', async () => {
    const revienta = () => { throw new DOMException('acceso denegado', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(revienta);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(revienta);

    render(<ThemeControl />);
    expect(boton('Sistema')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(boton('Oscuro'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(boton('Oscuro')).toHaveAttribute('aria-pressed', 'true');
  });
});
