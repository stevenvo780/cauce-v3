import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMEDIO, comprobarEntorno } from '../../scripts/preflight-deps.mjs';

const lockSano = "lockfileVersion: '9.0'\n";
const dirs: string[] = [];

function fixture({ lockInstalado = lockSano, canvas = true, esbuild = true } = {}): string {
  const raiz = mkdtempSync(join(tmpdir(), 'cauce-preflight-'));
  dirs.push(raiz);
  writeFileSync(join(raiz, 'package.json'), '{}\n');
  writeFileSync(join(raiz, 'pnpm-lock.yaml'), lockSano);
  mkdirSync(join(raiz, 'node_modules/.pnpm'), { recursive: true });
  writeFileSync(join(raiz, 'node_modules/.pnpm/lock.yaml'), lockInstalado);
  if (canvas) {
    mkdirSync(join(raiz, 'node_modules/@napi-rs/canvas'), { recursive: true });
    writeFileSync(join(raiz, 'node_modules/@napi-rs/canvas/package.json'), '{"name":"@napi-rs/canvas","main":"index.js"}\n');
    writeFileSync(join(raiz, 'node_modules/@napi-rs/canvas/index.js'), 'module.exports = {};\n');
  }
  if (esbuild) {
    mkdirSync(join(raiz, 'node_modules/esbuild/bin'), { recursive: true });
    writeFileSync(join(raiz, 'node_modules/esbuild/bin/esbuild'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return raiz;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('preflight de dependencias del gate', () => {
  it('pasa cuando el lockfile instalado coincide y los nativos cargan', () => {
    expect(comprobarEntorno({ raiz: fixture() })).toEqual([]);
  });

  it('detecta un node_modules instalado desde otro lockfile', () => {
    const problemas = comprobarEntorno({ raiz: fixture({ lockInstalado: "lockfileVersion: '6.0'\n" }) });
    expect(problemas).toEqual(['node_modules no coincide con pnpm-lock.yaml']);
  });

  it('detecta un node_modules sin registro del lockfile', () => {
    const raiz = fixture();
    rmSync(join(raiz, 'node_modules/.pnpm/lock.yaml'));
    expect(comprobarEntorno({ raiz })[0]).toContain('falta node_modules/.pnpm/lock.yaml');
  });

  it('detecta un módulo nativo que no carga, con el remedio en el mensaje del gate', () => {
    const raiz = fixture({ canvas: false });
    const problemas = comprobarEntorno({ raiz });
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('no carga el módulo nativo @napi-rs/canvas');
    expect(REMEDIO).toBe('ejecuta pnpm install --frozen-lockfile');
  });

  it('acumula todos los problemas en vez de parar en el primero', () => {
    const raiz = fixture({ lockInstalado: 'otro\n', esbuild: false });
    expect(comprobarEntorno({ raiz })).toHaveLength(2);
  });

  it('informa de un node_modules inexistente', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'cauce-preflight-vacio-'));
    dirs.push(raiz);
    writeFileSync(join(raiz, 'pnpm-lock.yaml'), lockSano);
    expect(comprobarEntorno({ raiz })[0]).toBe('no existe node_modules');
  });
});
