import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import type { CauceApi } from '../api/client';
import { useApi } from '../api/context';
import { renderWithApi, testApi } from './render';

function ApiProbe({ observe }: { observe: (api: CauceApi) => void }) {
  const api = useApi();
  useEffect(() => { observe(api); }, [api, observe]);
  return null;
}

const seen = new Set<CauceApi>();

describe.sequential('aislamiento de las sesiones de prueba', () => {
  it.each(['primera', 'segunda'])('%s prueba tiene otra API, pero conserva su sesión al remontar', () => {
    expect(seen.has(testApi)).toBe(false);
    seen.add(testApi);
    const observed: CauceApi[] = [];
    const observe = (api: CauceApi) => { observed.push(api); };
    const initial = renderWithApi(<ApiProbe observe={observe} />);
    initial.unmount();
    renderWithApi(<ApiProbe observe={observe} />);
    expect(observed).toEqual([testApi, testApi]);
  });
});
