import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ContextRepositoryPanel } from './ContextRepositoryPanel';

it('integrates the native GET client behind the secondary disclosure without disturbing the profile form', async () => {
  const base = 'http://localhost/v3/console/tenants/Steven/agents/helper/context/repository';
  const commit = 'a'.repeat(40);
  const root = 'tenants/Steven/agents/helper';
  const profile = { tenant_id: 'Steven', alias: 'helper', purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
  const file = (path: string, content: string) => ({ path, content, bytes: new TextEncoder().encode(content).length, sha256: 'c'.repeat(64) });
  const calls: string[] = [];
  server.use(http.get(base, () => HttpResponse.json({ tenant_id: 'Steven', alias: 'helper', state: 'configured', instance_id: 'fixture',
    storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated' })),
  http.all(`${base}/native-inspect`, ({ request }) => {
    calls.push(request.method);
    expect(new URL(request.url).searchParams.get('commit')).toBe(commit);
    return HttpResponse.json({ tenant_id: 'Steven', alias: 'helper', previous: null, changes: null,
      sourceState: 'not_observed', application: 'not_evaluated', applySupported: false,
      desired: { scope: { instance_id: 'fixture', tenant_id: 'Steven', alias: 'helper' }, commit, tree: 'b'.repeat(40), profile,
        profileSource: file(`${root}/profile.json`, JSON.stringify(profile)), manualSource: file(`${root}/native/codex/AGENTS.md`, 'native content'),
        sourceAgent: { tenant_id: 'Steven', alias: 'helper', source_journal: null, native_manual: { harness: 'codex' } } } });
  }));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" canApply />);
  await user.type(await screen.findByLabelText('Commit completo'), commit);
  await user.click(screen.getByText('Manual nativo de Git · sólo inspección'));
  await user.click(screen.getByRole('button', { name: 'Inspeccionar manual' }));
  expect(await screen.findByText('native content')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar/i })).not.toBeInTheDocument();
  await user.click(screen.getByText('Manual nativo de Git · sólo inspección'));
  expect(screen.getByLabelText('Commit completo')).toHaveValue(commit);
  await user.click(screen.getByText('Manual nativo de Git · sólo inspección'));
  expect(screen.queryByText('native content')).not.toBeInTheDocument();
  expect(calls).toEqual(['GET']);
});
