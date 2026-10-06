import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface Manifest {
  id: string;
  start_url: string;
  scope: string;
  icons: Icon[];
}

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const page = new DOMParser().parseFromString(read('index.html'), 'text/html');
const manifest = JSON.parse(read('public/manifest.json')) as Manifest;
const origin = 'https://console.example';

function readIcon(path: string) {
  const data = readFileSync(resolve(process.cwd(), 'public', path.slice(1)));
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(data.subarray(12, 16).toString()).toBe('IHDR');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  expect([...data.subarray(24, 29)]).toEqual([8, 2, 0, 0, 0]);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(data.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const filtered = inflateSync(Buffer.concat(chunks));
  const stride = width * 3;
  expect(filtered.length).toBe((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 3 ? pixels[index - 3] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 3 ? pixels[index - stride - 3] : 0;
      const prediction = left + up - upperLeft;
      const distances = [left, up, upperLeft].map((value) => Math.abs(prediction - value));
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2]
        ? left : distances[1] <= distances[2] ? up : upperLeft;
      const correction = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[index] = (filtered[y * (stride + 1) + x + 1] + correction) & 255;
    }
  }
  return { width, height, pixels };
}

describe('los recursos de instalación de la consola', () => {
  it('enlaza un manifiesto del mismo origen con las credenciales de acceso existentes', () => {
    const links = page.querySelectorAll('link[rel="manifest"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/manifest.json');
    expect(links[0].getAttribute('crossorigin')).toBe('use-credentials');
  });

  it('define una identidad estable y abre Conversaciones en modo independiente', () => {
    expect(manifest).toMatchObject({
      id: '/', name: 'Cauce V3', short_name: 'Cauce', lang: 'es',
      start_url: '/messages', scope: '/', display: 'standalone',
      theme_color: '#4338ca', background_color: '#0e0f14',
    });
    expect(manifest).not.toHaveProperty('prefer_related_applications', true);
    for (const path of [manifest.id, manifest.start_url, manifest.scope]) {
      const url = new URL(path, origin);
      expect(url.origin).toBe(origin);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
    }
  });

  it.each(['/messages', '/messages/tenant/agent?view=context', '/live', '/v3/auth/login', '/v3/auth/callback'])(
    'mantiene %s dentro del ámbito sin cambiar la URL visitada', (path) => {
      const current = new URL(path, origin);
      const href = page.querySelector('link[rel="manifest"]')?.getAttribute('href');
      expect(new URL(href ?? '', current).href).toBe(`${origin}/manifest.json`);
      expect(current.pathname.startsWith(new URL(manifest.scope, origin).pathname)).toBe(true);
      expect(new URL(manifest.start_url, origin).pathname.startsWith(manifest.scope)).toBe(true);
    },
  );

  it('incluye los tamaños de instalación de Chromium y un icono adaptable', () => {
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]));
  });

  it.each(manifest.icons)('sirve $src como PNG opaco del tamaño declarado', (icon) => {
    expect(icon.type).toBe('image/png');
    expect(icon.src).toMatch(/^\/icons\/[\w-]+\.png$/);
    const { width, height } = readIcon(icon.src);
    expect(`${String(width)}x${String(height)}`).toBe(icon.sizes);
  });

  it('mantiene toda la marca dentro del círculo seguro del icono adaptable', () => {
    const { width, height, pixels } = readIcon('/icons/cauce-maskable-512.png');
    const background = Buffer.from([67, 56, 202]);
    let foreground = 0;
    let radius = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        if (pixels.subarray(offset, offset + 3).equals(background)) continue;
        foreground++;
        radius = Math.max(radius, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
      }
    }
    expect(foreground).toBeGreaterThan(width * height / 20);
    expect(radius).toBeLessThanOrEqual(width * 0.4);
  });

  it('ofrece el icono y los metadatos de pantalla de inicio para iOS sin ocultar el área segura', () => {
    const touchIcon = page.querySelector('link[rel="apple-touch-icon"]');
    expect(touchIcon?.getAttribute('sizes')).toBe('180x180');
    expect(readIcon(touchIcon?.getAttribute('href') ?? '')).toMatchObject({ width: 180, height: 180 });
    expect(page.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
    expect(page.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('Cauce');
    expect(page.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, initial-scale=1.0');
    expect(page.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toBeNull();
  });
});
