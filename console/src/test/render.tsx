import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { CauceApi } from '../api/client';
import { ApiProvider } from '../api/context';

export const testApi = new CauceApi('http://localhost');

export function renderWithApi(element: ReactElement, options?: RenderOptions) {
  return render(<ApiProvider api={testApi}>{element}</ApiProvider>, options);
}
