import { render } from '@testing-library/react';
import type { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { FleetProvider } from '../../shell/fleet';
import { testApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/** The page as the shell mounts it: fed by the shared fleet poller, not by its own reads. */
export function renderLive(api: CauceApi = testApi) {
  return render(<ApiProvider api={api}><FleetProvider><LiveFleetPage /></FleetProvider></ApiProvider>);
}
