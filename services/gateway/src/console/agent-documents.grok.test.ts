import { describe, expect, it } from 'vitest';
import { AgentRegistry, parseAgentPresence } from '../terminal/registry.js';
import { hechosDelRegistro } from '../terminal/hechos-del-registro.js';
import { effectiveManualPaths, harnessFromCapabilities, harnessFromCommand, profileDocumentPaths, resolveAgentDocuments } from './agent-documents.js';

const relay = { relay_instance_id: 'a'.repeat(64), relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const presence = { tenant_id: 'Steven', alias: 'hades', container_id: 'container', generation: '1', image_id: 'image', runtime_user: 'claw', runtime_uid: 1001,
  harness: 'grok', runtime_facts_observed: true, home: '/home/claw', grok_workspace: '/workspace/project', modes: ['shell', 'harness'], connected_since: 'fixture' };

describe('Grok documents use current relay measurements', () => {
  it('carries a measured workspace through registry to exact profile and manual paths', async () => {
    const registry = new AgentRegistry(); registry.observe(relay, [parseAgentPresence(presence)]);
    const measured = await hechosDelRegistro(registry).factsFor('Steven', 'hades'); expect(measured?.source).toBe('measured');
    expect(measured?.facts).toMatchObject({ harness: 'grok', home: '/home/claw', grokWorkspace: '/workspace/project' });
    if (!measured) throw new Error('Grok measurement absent');
    expect(profileDocumentPaths(measured.facts)).toEqual(['/workspace/project/AGENTS.md']);
    expect(effectiveManualPaths(measured.facts).map(doc => doc.path)).toEqual(['/workspace/project/AGENTS.md']);
    expect(resolveAgentDocuments(measured.facts)).toEqual([expect.objectContaining({ path: '/workspace/project/AGENTS.md', editable: false })]);
  });
  it('never substitutes login home or an invalid workspace for a missing runtime fact', async () => {
    for (const grok_workspace of [undefined, 'relative', '/', '/workspace/../project']) {
      const registry = new AgentRegistry(); registry.observe(relay, [parseAgentPresence({ ...presence, grok_workspace, GROK_HOME: '/profiles/login' })]);
      expect(await hechosDelRegistro(registry).factsFor('Steven', 'hades')).toBeUndefined();
    }
  });
  it('recognizes Grok from its adapter and reported harness capability', () => {
    expect(harnessFromCommand('/usr/bin/node /release/bin/grok.js')).toBe('grok');
    expect(harnessFromCapabilities(['harness.grok'])).toBe('grok');
  });
});
