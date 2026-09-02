import { render, type RenderOptions } from '@testing-library/react';
import type { ComponentType, ReactElement } from 'react';
import { CauceApi } from '../api/client';
import { ApiProvider } from '../api/context';
import { useRouteSegments } from '../router';

export const testApi = new CauceApi('http://localhost');

export function renderWithApi(element: ReactElement, options?: RenderOptions) {
  return render(<ApiProvider api={testApi}>{element}</ApiProvider>, options);
}

/**
 * A routed view outside `App`, fed by the same router. Suites that navigate by CLICKING need it:
 * the click pushes state and the page only follows if something re-renders it on `popstate`.
 */
export function renderRouted(
  Page: ComponentType<{ params?: readonly string[] }>,
  options?: RenderOptions,
) {
  function Routed() {
    const [, ...rest] = useRouteSegments();
    return <Page params={rest} />;
  }
  return renderWithApi(<Routed />, options);
}
