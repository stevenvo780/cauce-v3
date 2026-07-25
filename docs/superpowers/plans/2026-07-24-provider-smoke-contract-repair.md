# Provider Smoke Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the persistent `provider-smoke` named workflow accept canonical model IDs in `providers`, reject malformed input before delegation, and document the exact restart-safe contract.

**Architecture:** Keep the workflow self-contained. Build a canonical provider catalog from `BASE` and `EXTRAS`, normalize public string IDs and advanced objects into validated leg objects before the quota phase, then reuse the existing quota resolver and fan-out unchanged. Test the real workflow source with a Node `vm` harness that mocks workflow globals, followed by a live named-workflow smoke test.

**Tech Stack:** Plain JavaScript workflow runtime, Node.js built-in `node:test`, `node:vm`, Claude Code named workflows, Markdown documentation.

## Global Constraints

- Persistent source: `/home/dev/.claude/workflows/provider-smoke.js`; never patch session-generated copies.
- `providers` accepts a non-empty `Array<string | ProviderSpec>`; canonical model-ID strings are the recommended public form.
- Preserve object and JSON-string forms of top-level `args`.
- Preserve all ten canonical cloud routes and existing quota-routing behavior.
- Invalid input must fail before the quota agent or any provider leg starts.
- Do not add npm dependencies or refactor unrelated harness code.
- Do not commit unless the user explicitly requests a commit.

---

## File Structure

- Modify `/home/dev/.claude/workflows/provider-smoke.js`: public metadata, argument parsing, provider normalization, validation, and selection.
- Create `/home/dev/.claude/workflows/provider-smoke.test.mjs`: deterministic tests that execute the actual workflow source with mocked runtime globals.
- Modify `/home/dev/.claude/projects/-workspace-cauce-v3/memory/delegacion-multi-proveedor-validada.md`: persistent operator-facing contract and ten-route count.
- Keep `docs/superpowers/specs/2026-07-24-provider-smoke-contract-design.md` as the approved design record.

### Task 1: Add Contract Regression Tests

**Files:**
- Create: `/home/dev/.claude/workflows/provider-smoke.test.mjs`
- Test: `/home/dev/.claude/workflows/provider-smoke.test.mjs`

**Interfaces:**
- Consumes: the self-contained workflow source and its globals `args`, `phase`, `log`, `agent`, and `parallel`.
- Produces: `executeWorkflow(argsValue)` returning `{ result, calls }`, where `calls` records every mocked agent invocation.

- [ ] **Step 1: Create the VM test harness**

Use Node built-ins only. Read `provider-smoke.js`, replace `export const meta =` with `const meta =`, wrap the source in an async function, and provide mocks:

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const workflowUrl = new URL('./provider-smoke.js', import.meta.url)

async function executeWorkflow(argsValue, calls = []) {
  const source = (await readFile(workflowUrl, 'utf8'))
    .replace(/^export const meta = /m, 'const meta = ')
  const phase = () => {}
  const log = () => {}
  const agent = async (prompt, options) => {
    calls.push({ prompt, options })
    if (options.label === 'cuotas ⇒ get_ai_quotas') {
      return { porProveedor: { claude: 100, codex: 100, antigravity: 100, minimax: 100 } }
    }
    const provider = prompt.match(/proveedor "([^"]+)"/)[1]
    const modelUsado = prompt.match(/modelUsado="([^"]+)"/)[1]
    const magic = prompt.match(/contiene "(RESULTADO=\d+)"/)[1]
    const nonce = prompt.match(/Y "NONCE=([^"]+)"/)[1]
    return { provider, modelUsado, ok: true, respuesta: `${magic}\nNONCE=${nonce}`, nota: '' }
  }
  const parallel = thunks => Promise.all(thunks.map(thunk => thunk()))
  const factory = new vm.Script(
    `(async (args, phase, log, agent, parallel) => { ${source}\n})`,
    { filename: workflowUrl.pathname },
  ).runInNewContext()
  const result = await factory(argsValue, phase, log, agent, parallel)
  return { result, calls }
}
```

- [ ] **Step 2: Add the original-failure regression**

Invoke with the exact six string IDs used in the failed run and assert six correct provider/model markers, no `undefined`, and one quota call plus six provider calls:

```js
test('normalizes canonical provider model strings', async () => {
  const providers = [
    'minimax/MiniMax-M3',
    'gemini/flash',
    'gemini/pro',
    'codex/gpt-5.6-sol',
    'claude/sonnet',
    'claude/opus',
  ]
  const { result, calls } = await executeWorkflow({ nonce: 'string-regression', strict: true, providers })
  assert.equal(result.detalles.length, providers.length)
  assert.deepEqual(result.detalles.map(item => item.provider), [
    'minimax-m3', 'gemini-flash', 'gemini-pro', 'codex-sol', 'claude-sonnet', 'claude-opus',
  ])
  assert.equal(JSON.stringify(result).includes('undefined'), false)
  assert.equal(calls.length, providers.length + 1)
})
```

- [ ] **Step 3: Add compatibility and validation cases**

Add tests for JSON-string `args`, a mixed canonical string plus advanced object, unknown model, empty/non-array `providers`, malformed object, and duplicate keys. Invalid cases must use `assert.rejects` and assert `calls.length === 0`.

```js
const calls = []
await assert.rejects(
  () => executeWorkflow({ providers: ['example/model'] }, calls),
  /provider-smoke: providers\[0\] has unknown model "example\/model"/,
)
assert.equal(calls.length, 0)
```

- [ ] **Step 4: Run the regression suite and confirm RED**

Run:

```bash
node --test /home/dev/.claude/workflows/provider-smoke.test.mjs
```

Expected: the string-ID and validation tests fail against the current workflow; the advanced-object compatibility case may pass.

### Task 2: Normalize and Validate Provider Inputs

**Files:**
- Modify: `/home/dev/.claude/workflows/provider-smoke.js:1-17`
- Modify: `/home/dev/.claude/workflows/provider-smoke.js:42-96`
- Test: `/home/dev/.claude/workflows/provider-smoke.test.mjs`

**Interfaces:**
- Consumes: `args.providers?: Array<string | ProviderSpec>`, `BASE`, and `EXTRAS`.
- Produces: `SELECTED_LEGS`, an array of validated cloned leg objects accepted by existing `resolver(leg)`.

- [ ] **Step 1: Make top-level argument parsing fail clearly**

Replace the silent JSON fallback with deterministic validation:

```js
const fail = message => { throw new Error(`provider-smoke: ${message}`) }

let A = args
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch (error) { fail(`args is not valid JSON: ${error.message}`) }
}
if (A == null) A = {}
if (typeof A !== 'object' || Array.isArray(A)) fail('args must be an object or a JSON object string')
```

Then derive `NONCE`, `FULL`, and `STRICT` from validated `A`.

- [ ] **Step 2: Build a canonical catalog and clone helper**

Immediately after `EXTRAS`, define:

```js
const CANONICAL = [...BASE, ...EXTRAS]
const BY_MODEL = new Map(CANONICAL.map(leg => [leg.model, leg]))
const ALLOWED_MODELS = CANONICAL.map(leg => leg.model)
const cloneLeg = leg => ({
  ...leg,
  fallbacks: (leg.fallbacks || []).map(fallback => ({ ...fallback })),
})
```

- [ ] **Step 3: Normalize strings and validate advanced objects**

Implement `normalizeProvider(raw, index)` so strings clone a canonical leg and objects require non-empty `key`, canonical `model`, non-empty `quotaKey`, non-empty `magic`, non-empty `tarea`, and an array `fallbacks`. Validate fallback model IDs and optional Codex effort values. Every error must include `providers[index]`.

```js
const normalizeProvider = (raw, index) => {
  const path = `providers[${index}]`
  if (typeof raw === 'string') {
    const leg = BY_MODEL.get(raw)
    if (!leg) fail(`${path} has unknown model "${raw}". Expected one of: ${ALLOWED_MODELS.join(', ')}`)
    return cloneLeg(leg)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${path} must be a canonical model ID string or ProviderSpec object`)
  }
  for (const field of ['key', 'model', 'quotaKey', 'magic', 'tarea']) {
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') fail(`${path}.${field} must be a non-empty string`)
  }
  if (!BY_MODEL.has(raw.model)) fail(`${path}.model has unknown model "${raw.model}". Expected one of: ${ALLOWED_MODELS.join(', ')}`)
  if (!Array.isArray(raw.fallbacks)) fail(`${path}.fallbacks must be an array`)
  raw.fallbacks.forEach((fallback, fallbackIndex) => {
    const fallbackPath = `${path}.fallbacks[${fallbackIndex}]`
    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) fail(`${fallbackPath} must be an object`)
    if (!BY_MODEL.has(fallback.model)) fail(`${fallbackPath}.model has unknown model "${fallback.model}"`)
    if (typeof fallback.quotaKey !== 'string' || fallback.quotaKey.trim() === '') fail(`${fallbackPath}.quotaKey must be a non-empty string`)
  })
  if (raw.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(raw.effort)) {
    fail(`${path}.effort must be low, medium, high, or xhigh`)
  }
  return cloneLeg(raw)
}
```

- [ ] **Step 4: Select and deduplicate legs before the quota phase**

Use `providers` whenever the property exists, preserving its precedence over `full:true`; reject empty arrays and duplicate keys:

```js
let selected
if (Object.prototype.hasOwnProperty.call(A, 'providers')) {
  if (!Array.isArray(A.providers)) fail('providers must be an array')
  if (A.providers.length === 0) fail('providers must not be empty')
  selected = A.providers.map(normalizeProvider)
} else {
  selected = (FULL ? CANONICAL : BASE).map(cloneLeg)
}
const seenKeys = new Set()
for (const [index, leg] of selected.entries()) {
  if (seenKeys.has(leg.key)) fail(`providers[${index}] duplicates key "${leg.key}"`)
  seenKeys.add(leg.key)
}
```

Place this before `phase('Cuotas')`. After quotas load, change line 96 to:

```js
const LEGS = selected.map(resolver)
```

- [ ] **Step 5: Update public metadata**

Make `whenToUse` state the exact contract and recommended form, including one compact model-ID example and `full:true` for all ten routes. Do not refer to an unspecified `providers: [...]`.

- [ ] **Step 6: Run the contract suite and confirm GREEN**

Run:

```bash
node --test /home/dev/.claude/workflows/provider-smoke.test.mjs
```

Expected: all tests pass, zero invalid-case agent calls, and no serialized result contains `undefined`.

### Task 3: Correct Persistent Documentation

**Files:**
- Modify: `/home/dev/.claude/projects/-workspace-cauce-v3/memory/delegacion-multi-proveedor-validada.md:11-20`
- Verify: `/home/dev/.claude/projects/-workspace-cauce-v3/memory/MEMORY.md`

**Interfaces:**
- Consumes: the implemented workflow contract and canonical ten-route catalog.
- Produces: restart-loaded operator guidance with one non-ambiguous invocation form.

- [ ] **Step 1: Correct the route inventory**

Replace “8 rutas” with “10 rutas cloud exactas” and list M3, M2.7, Gemini Flash/Pro, Claude Sonnet/Opus, and Codex Spark/Sol/Luna/Terra. Keep historical notes about removed providers separate from the canonical count.

- [ ] **Step 2: Document both argument transports and provider element forms**

State that top-level `args` may arrive as an object or JSON string, while `providers` is a non-empty array of canonical model-ID strings or validated advanced objects. Include this copyable example:

```json
{"nonce":"smoke-unique","strict":true,"providers":["minimax/MiniMax-M3","gemini/flash","codex/gpt-5.6-sol"]}
```

- [ ] **Step 3: Verify the memory index remains accurate**

Read `MEMORY.md`; update its one-line hook only if it still describes eight routes or the old ambiguous contract. Do not duplicate the memory entry.

### Task 4: Verify Persistent Reload and Live Consumption

**Files:**
- Verify: `/home/dev/.claude/workflows/provider-smoke.js`
- Verify: `/home/dev/.claude/workflows/provider-smoke.test.mjs`
- Verify: `/home/dev/.claude/projects/-workspace-cauce-v3/memory/delegacion-multi-proveedor-validada.md`

**Interfaces:**
- Consumes: the named workflow registry and corrected persistent source.
- Produces: deterministic test evidence plus a fresh live nonce result from a newly loaded named workflow.

- [ ] **Step 1: Re-run the complete local suite**

```bash
node --test /home/dev/.claude/workflows/provider-smoke.test.mjs
```

Expected: all contract tests pass with zero failures.

- [ ] **Step 2: Read live quotas before provider fan-out**

Call `get_ai_quotas`. Select exact routes with available quota for the live strict test; do not silently downgrade. If Claude or a Codex group is exhausted, keep the deterministic exact-six regression as coverage and omit only the unavailable live leg with an explicit report.

- [ ] **Step 3: Invoke the workflow by registered name, not script path**

Use a fresh nonce and canonical string IDs:

```json
{
  "name": "provider-smoke",
  "args": "{\"nonce\":\"provider-contract-live-20260724-b7f4a2\",\"strict\":true,\"providers\":[\"minimax/MiniMax-M3\",\"gemini/flash\",\"gemini/pro\"]}"
}
```

Expected: every selected leg is `CONSUMIDO Y VERIFICADO (nonce ok)`, every marker names the requested model, and no output contains `undefined`.

- [ ] **Step 4: Verify invalid input fails before agents**

Invoke the VM suite invalid cases and confirm `calls.length === 0`; do not spend live provider quota on invalid payloads.

- [ ] **Step 5: Report restart readiness accurately**

State that the persistent source and restart-loaded documentation were modified, local contract tests passed, and the named workflow reloaded from its registered name. Distinguish this from a literal process restart, which the user performs after completion.
