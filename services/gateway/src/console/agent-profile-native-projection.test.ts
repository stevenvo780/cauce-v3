import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  FICHEROS_OPENCLAW,
  bloqueDePerfil,
  marcaDeRevisionDelPerfil,
  profileRuntimeAdoptionFor,
  type AgentProfile,
  type ContextoDeAlias,
  type ProfileRuntimeContract,
} from '@cauce/protocol';
import type {
  AgentFactsProbe,
  GovernanceBatchWriteAck,
  GovernanceDocumentContent,
} from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';
import {
  registerAgentProfileRoutes,
  type AgentProfileDeps,
  type PerfilAplicado,
  type ProfileRuntimeVerification,
} from './agent-profile.routes.js';

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };
const URL = '/v3/console/tenants/Steven/agents/zeus/perfil';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function profile(marker: string): Omit<AgentProfile, 'tenant_id' | 'alias'> {
  return {
    purpose: `purpose-${marker}`,
    role_summary: `role-${marker}`,
    human_brief: `human-${marker}`,
    responsibilities: [`responsibility-${marker}`],
    restrictions: [`restriction-${marker}`],
    tools: [`tool-${marker}`],
    operating_rules: [`rule-${marker}`],
  };
}

function contextFor(
  authored: Omit<AgentProfile, 'tenant_id' | 'alias'>,
  harness: 'claude' | 'openclaw',
): ContextoDeAlias {
  return {
    perfil: { tenant_id: 'Steven', alias: 'zeus', ...authored },
    hechos: {
      permisos: { ruta: true, lectura: true, control: true, notificacion: false },
      cuotas: [],
      arnes: { harness, home: '/home/dev', contenedor: 'runtime-zeus', capacidades: [] },
      destinos: [],
    },
  };
}

function content(text: string): GovernanceDocumentContent {
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: false,
    modified_at: '2026-08-28T00:00:00.000Z',
    sha: sha(text),
  };
}

function liveRuntime(harness: 'claude' | 'openclaw'): {
  readonly disk: Map<string, string>;
  readonly paths: readonly string[];
  readonly probe: AgentFactsProbe;
} {
  const home = '/home/dev';
  const workspace = '/home/dev/.openclaw/workspace-zeus';
  const facts: RuntimeFacts = harness === 'claude'
    ? {
        harness,
        home,
        claudeConfigDir: '/home/dev/.claude',
        generation: 'generation-zeus',
        containerId: 'runtime-zeus',
      }
    : {
        harness,
        home,
        openclawWorkspace: workspace,
        generation: 'generation-zeus',
        containerId: 'runtime-zeus',
      };
  const paths = harness === 'claude'
    ? ['/home/dev/.claude/CLAUDE.md']
    : FICHEROS_OPENCLAW.map((name) => `${workspace}/${name}`);
  const disk = new Map<string, string>();
  if (harness === 'claude') {
    disk.set(paths[0] ?? expect.unreachable('Claude runtime path is missing'), '# Human manual\n');
  } else {
    disk.set(`${workspace}/MEMORY.md`, 'PRIVATE MEMORY\n');
    disk.set(`${workspace}/HEARTBEAT.md`, 'PRIVATE HEARTBEAT\n');
  }

  const probe: AgentFactsProbe = {
    factsFor: async () => ({ facts, source: 'measured' }),
    readGovernanceDocument: async (path) => {
      const text = disk.get(path);
      return text === undefined ? { error: 'not_found', reason: 'missing' } : content(text);
    },
    listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'not needed' }),
    writeGovernanceBatch: async (writes) => {
      for (const write of writes) {
        const before = disk.get(write.path);
        const valid = write.precondition.state === 'absent'
          ? before === undefined
          : before !== undefined && sha(before) === write.precondition.sha256;
        if (!valid) return { error: 'conflict', reason: 'precondition changed' };
      }
      const acknowledgements: GovernanceBatchWriteAck[] = [];
      for (const write of writes) {
        const before = disk.get(write.path);
        if (write.mode === 'write') disk.set(write.path, write.content);
        const after = disk.get(write.path);
        acknowledgements.push({
          path: write.path,
          operation: write.mode === 'verify'
            ? (after === undefined ? 'absent' : 'unchanged')
            : (before === undefined ? 'create' : 'replace'),
          sha: after === undefined ? null : sha(after),
          bytes: after === undefined ? 0 : Buffer.byteLength(after, 'utf8'),
        });
      }
      return acknowledgements;
    },
  };
  return { disk, paths, probe };
}

function verificationKey(revision: number, verification: ProfileRuntimeVerification): string {
  return JSON.stringify({
    revision,
    generation: verification.generation,
    documents: verification.documents.map((document) => [
      document.name, document.path, document.expected_sha, document.expected_bytes,
    ]),
  });
}

describe('native profile publishing saga', () => {
  it.each(['claude', 'openclaw'] as const)(
    'reprojects two %s revisions and advances applied only through exact path/SHA evidence',
    async (harness) => {
      const runtime = liveRuntime(harness);
      let current = contextFor(profile('alpha'), harness);
      let revision = 1;
      let appliedRevision = 1;
      let exactAdoptionFor: number | undefined;
      let runtimeAdoption: ReturnType<typeof profileRuntimeAdoptionFor> = undefined;
      const expectations = new Map<number, {
        readonly key: string;
        readonly contract: ProfileRuntimeContract;
      }>();
      const events: string[] = [];

      const deps: AgentProfileDeps = {
        authorize: async () => ACTOR,
        authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'zeus', enabled: true }),
        readContext: async () => ({
          contexto: current,
          exists: true,
          revision,
          applied_revision: appliedRevision,
        }),
        replaceProfile: async (next, expectedRevision) => {
          if (expectedRevision !== revision) {
            throw Object.assign(new Error('stale revision'), { code: 'conflict' });
          }
          if (JSON.stringify(next) !== JSON.stringify(current.perfil)) revision += 1;
          current = { ...current, perfil: next };
          events.push(`replace:${String(revision)}`);
          return {
            perfil: next,
            exists: true,
            revision,
            applied_revision: appliedRevision,
          };
        },
        prepareRuntime: async (tenantId, alias, next) => {
          events.push('prepare');
          const preflight = await prepareAgentProfileRuntime(
            runtime.probe, tenantId, alias, next,
          );
          return {
            ...preflight,
            materialize: (materializedRevision: number) => {
              events.push(`materialize:${String(materializedRevision)}`);
              const prepared = preflight.materialize(materializedRevision);
              return {
                ...prepared,
                apply: async () => {
                  events.push('apply');
                  return prepared.apply();
                },
              };
            },
          };
        },
        recordRuntimeExpectation: async (_tenant, _alias, expectedRevision, verification) => {
          for (const document of verification.documents) {
            const text = runtime.disk.get(document.path)
              ?? expect.unreachable(`Runtime document is missing: ${document.path}`);
            expect(document.expected_sha).toBe(sha(text));
            expect(document.expected_bytes).toBe(Buffer.byteLength(text, 'utf8'));
          }
          expectations.set(expectedRevision, {
            key: verificationKey(expectedRevision, verification),
            contract: {
              revision: expectedRevision,
              generation: verification.generation
                ?? expect.unreachable('Runtime verification generation is missing'),
              documents: verification.documents.map((document) => ({
                name: document.name,
                path: document.path,
                sha: document.expected_sha,
              })),
            },
          });
          events.push(`expect:${String(expectedRevision)}`);
        },
        readRuntimeAdoption: async (_tenant, _alias, expectedRevision, verification) => {
          events.push(`adopt:${String(expectedRevision)}`);
          const expectation = expectations.get(expectedRevision);
          if (expectation?.key !== verificationKey(expectedRevision, verification)
            || verification.generation === null
            || runtimeAdoption?.revision !== expectedRevision
            || runtimeAdoption.generation !== verification.generation) return undefined;
          return {
            ...runtimeAdoption,
            adopted_at: '2026-08-28T01:00:00.000Z',
          };
        },
        markProfileApplied: async (_tenant, _alias, expectedRevision) => {
          if (exactAdoptionFor !== expectedRevision) {
            throw Object.assign(new Error('missing exact adoption'), { code: 'conflict' });
          }
          appliedRevision = expectedRevision;
          events.push(`mark:${String(expectedRevision)}`);
          return {
            perfil: current.perfil,
            exists: true,
            revision,
            applied_revision: appliedRevision,
          };
        },
      };
      const app = Fastify();
      registerAgentProfileRoutes(app, deps);
      await app.ready();
      try {
        const supplyExactAdoption = (expectedRevision: number): void => {
          const expectation = expectations.get(expectedRevision)
            ?? expect.unreachable('Runtime expectation is missing');
          runtimeAdoption = profileRuntimeAdoptionFor(
            expectation.contract,
            runtime.paths.flatMap((path) => {
              const text = runtime.disk.get(path);
              return text === undefined ? [] : [{ path, sha256: sha(text) }];
            }),
          );
          expect(runtimeAdoption?.revision).toBe(expectedRevision);
          exactAdoptionFor = expectedRevision;
          events.push(`evidence:${String(expectedRevision)}`);
        };

        const first = await app.inject({
          method: 'PUT',
          url: URL,
          payload: { expected_revision: 1, profile: profile('beta') },
        });
        expect(first.statusCode).toBe(202);
        expect(first.json()).toMatchObject({ revision: 2, applied_revision: 1 });
        const revisionTwoBytes = runtime.paths.map((path) => runtime.disk.get(path));
        supplyExactAdoption(2);
        const firstApplied = await app.inject({
          method: 'PUT',
          url: URL,
          payload: { expected_revision: 2, profile: profile('beta') },
        });
        expect(firstApplied.statusCode).toBe(200);
        expect(firstApplied.json<PerfilAplicado>()).toMatchObject({
          revision: 2,
          applied_revision: 2,
          runtime_adoption: { revision: 2 },
        });
        expect(runtime.paths.map((path) => runtime.disk.get(path))).toEqual(revisionTwoBytes);

        const second = await app.inject({
          method: 'PUT',
          url: URL,
          payload: { expected_revision: 2, profile: profile('gamma') },
        });
        expect(second.statusCode).toBe(202);
        expect(second.json()).toMatchObject({ revision: 3, applied_revision: 2 });
        supplyExactAdoption(3);
        const secondApplied = await app.inject({
          method: 'PUT',
          url: URL,
          payload: { expected_revision: 3, profile: profile('gamma') },
        });
        expect(secondApplied.statusCode).toBe(200);
        expect(secondApplied.json<PerfilAplicado>()).toMatchObject({
          revision: 3,
          applied_revision: 3,
          runtime_adoption: { revision: 3 },
        });
        expect(events).toEqual([
          'prepare', 'replace:2', 'materialize:2', 'apply', 'expect:2', 'adopt:2',
          'evidence:2',
          'prepare', 'replace:2', 'materialize:2', 'apply', 'expect:2', 'adopt:2', 'mark:2',
          'prepare', 'replace:3', 'materialize:3', 'apply', 'expect:3', 'adopt:3',
          'evidence:3',
          'prepare', 'replace:3', 'materialize:3', 'apply', 'expect:3', 'adopt:3', 'mark:3',
        ]);
        expect(expectations.get(2)?.key).not.toBe(expectations.get(3)?.key);
        expect(expectations.get(3)?.contract.documents.map((document) => document.name))
          .toEqual(harness === 'claude' ? ['CLAUDE.md'] : FICHEROS_OPENCLAW);

        const firstPath = runtime.paths[0] ?? expect.unreachable('Primary runtime path is missing');
        if (harness === 'claude') {
          const text = runtime.disk.get(firstPath) ?? '';
          expect(text).toContain(marcaDeRevisionDelPerfil(3));
          expect(text).not.toContain(marcaDeRevisionDelPerfil(2));
          expect(bloqueDePerfil(text)).toContain('gamma');
          expect(bloqueDePerfil(text)).not.toContain('beta');
          expect(runtime.paths.map((path) => runtime.disk.get(path))).not.toEqual(revisionTwoBytes);
        } else {
          for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md']) {
            const text = runtime.disk.get(`${firstPath.slice(0, firstPath.lastIndexOf('/'))}/${name}`) ?? '';
            const block = bloqueDePerfil(text) ?? '';
            expect(block).toContain('gamma');
            expect(block).not.toContain('beta');
            if (name === 'AGENTS.md') {
              expect(text).toContain(marcaDeRevisionDelPerfil(3));
              expect(text).not.toContain(marcaDeRevisionDelPerfil(2));
            } else {
              expect(text).not.toContain('CAUCE:REVISION-PERFIL');
            }
          }
          expect(runtime.disk.get(runtime.paths[3]
            ?? expect.unreachable('OpenClaw memory path is missing'))).toBe('PRIVATE MEMORY\n');
          expect(runtime.disk.get(runtime.paths[4]
            ?? expect.unreachable('OpenClaw heartbeat path is missing'))).toBe('PRIVATE HEARTBEAT\n');
        }
      } finally {
        await app.close();
      }
    },
  );
});
