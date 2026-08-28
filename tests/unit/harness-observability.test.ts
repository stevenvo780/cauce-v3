import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { AdapterError } from '../../packages/adapter-sdk/src/sdk/errors.js';
import { fakeDefinition } from '../../packages/adapter-sdk/src/harnesses/fake.js';
import { HarnessAdapter } from '../../packages/adapter-sdk/src/harnesses/shared.js';
import type {
  CommandRunResult, CommandRunner
} from '../../packages/adapter-sdk/src/sdk/types.js';

/**
 * Harness observability: validation of the diagnostic information and preservation of
 * errors in `last_error` after execution failures or cancellations.
 */

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function freshStore(): Promise<DurableStore> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-harness-observability-'));
  temporaryDirectories.push(directory);
  return DurableStore.open(directory);
}

function runnerReturning(result: Partial<CommandRunResult>): CommandRunner {
  return {
    run: (): Promise<CommandRunResult> => Promise.resolve({
      stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
      ...result
    })
  };
}

async function adapterWith(runner: CommandRunner): Promise<HarnessAdapter> {
  return new HarnessAdapter({ definition: fakeDefinition, runner, store: await freshStore() });
}

/** Runs the adapter requiring it to fail, and returns the typed AdapterError. */
async function rejectionOf(adapter: HarnessAdapter, signal: AbortSignal): Promise<AdapterError> {
  try {
    await adapter.execute({ prompt: 'ejecutar una vez', timeoutMs: 2_000, signal });
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('se esperaba que el harness fallara');
}

/** The harness fails and returns the cause via stderr; we capture the resulting AdapterError. */
async function failureFor(stderr: string, exitCode = 1): Promise<AdapterError> {
  const adapter = await adapterWith(runnerReturning({ stdout: 'no-structured-output', stderr, exitCode }));
  return rejectionOf(adapter, new AbortController().signal);
}

describe('causa real del fallo del harness en last_error', () => {
  /**
   * Preserves the full detail of a multi-line error message.
   */
  it('conserva entera una causa de dos líneas', async () => {
    const stderr = [
      'Error loading config.toml: unknown variant `writes`, expected one of `untrusted`, `on-failure`, `on-request`, `never`',
      '  in `mcp_servers.chrome-devtools.default_tools_approval_mode`'
    ].join('\n');

    const error = await failureFor(stderr);

    expect(error.code).toBe('PROCESS_EXIT_AMBIGUOUS');
    expect(error.message).toContain('unknown variant `writes`');
    expect(error.message).toContain('mcp_servers.chrome-devtools.default_tools_approval_mode');
  });

  /**
   * Preserves the header and tail of stderr when it exceeds the budget.
   */
  it('conserva el final del stderr, no sólo el principio', async () => {
    const encabezado = 'FATAL: el proveedor abortó la sesión';
    const causaRaiz = 'caused by: config key `mcp_servers.chrome-devtools.default_tools_approval_mode` is invalid';
    const relleno = Array.from({ length: 400 }, (_unused, index) => `  at frame_${index} (/opt/harness/lib/runtime.js)`);
    const stderr = [encabezado, ...relleno, causaRaiz].join('\n');

    const error = await failureFor(stderr);

    expect(error.message).toContain(encabezado);
    expect(error.message).toContain(causaRaiz);
    expect(error.message).toContain('caracteres omitidos');
    // The detail still sits comfortably below the 2000 cap of `BaseAckSchema.error`, which
    // is what used to make a long message tear down the adapter connection.
    expect(error.message.length).toBeLessThan(2_000);
  });

  /**
   * Widening the budget does not widen the leak surface: redaction runs BEFORE the trim, so a
   * secret that lands in the freshly kept tail is already masked.
   */
  it('redacta secretos que caen en la cola recién conservada', async () => {
    const secreto = 'sk-live-9f3ac1b7d2e84a06';
    const relleno = Array.from({ length: 400 }, (_unused, index) => `  at frame_${index} (/opt/harness/lib/runtime.js)`);
    const stderr = [
      'FATAL: el proveedor rechazó las credenciales',
      ...relleno,
      `caused by: api_key=${secreto} was rejected upstream`
    ].join('\n');

    const error = await failureFor(stderr);

    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(secreto);
    expect(error.message).toContain('was rejected upstream');
  });

  /**
   * Common forms of credentials and tokens that MUST be redacted in the message.
   */
  it.each([
    ['prefijo de palabra rompe el \\b', 'ANTHROPIC_API_KEY=sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['el esquema Bearer se comía el match', 'Authorization: Bearer sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb'],
    ['credenciales embebidas en una URL', 'postgres://usuario:clavesecretaaaa@db.interno/cauce'],
    ['la comilla entre clave y dos puntos', '{"api_key":"sk-proj-cccccccccccccccccccc"}'],
    ['prefijo conocido sin clave que lo nombre', 'ghp_dddddddddddddddddddddddddddddddddddd'],
    ['la key de Neon que vive en la config de la flota', 'napi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    ['un JWT suelto', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk']
  ])('no deja escapar un secreto: %s', async (_caso, linea) => {
    const error = await failureFor(`FATAL: el proveedor rechazó las credenciales\n${linea}`);

    expect(error.message).toContain('[REDACTED]');
    // The secret body does not survive in any form.
    for (const fragmento of ['sk-ant-aaaa', 'sk-ant-bbbb', 'clavesecretaaaa', 'sk-proj-cccc',
                             'ghp_dddd', 'napi_eeee', 'dBjftJeZ']) {
      expect(error.message).not.toContain(fragmento);
    }
  });

  /**
   * Ensures syntactic or configuration error messages are not wrongly redacted.
   */
  it('no redacta la causa real: el mensaje de config.toml sobrevive entero', async () => {
    const causa = 'Error loading config.toml: unknown variant `writes`, expected one of '
      + '`auto`, `prompt`, `approve`\nin `mcp_servers.chrome-devtools.default_tools_approval_mode`';

    const error = await failureFor(causa);

    expect(error.message).toContain('unknown variant `writes`');
    expect(error.message).toContain('default_tools_approval_mode');
    expect(error.message).not.toContain('[REDACTED]');
  });

  it('no inventa detalle cuando el harness no escribió nada en stderr', async () => {
    const error = await failureFor('   \n  \n');

    expect(error.code).toBe('PROCESS_EXIT_AMBIGUOUS');
    expect(error.message).toContain('completion state is unknown');
  });
});

describe('motivo del aborto en last_error', () => {
  /**
   * Propagates the real cancellation reason when the runner reports it.
   */
  it('propaga el motivo cuando el runner reporta la cancelación', async () => {
    const controller = new AbortController();
    // The abort happens DURING the run: the process was already dispatched, so the completion
    // state is genuinely ambiguous. Aborting before `execute` is a different path, and there
    // the raw reason is returned because nothing was spent yet.
    const adapter = await adapterWith({
      run: (): Promise<CommandRunResult> => {
        controller.abort(new AdapterError(
          'CLAIM_OWNERSHIP_LOST',
          'Gateway rejected the delivery lease renewal; execution ownership was lost',
          false
        ));
        return Promise.resolve({
          stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: true
        });
      }
    });

    const error = await rejectionOf(adapter, controller.signal);

    // The error code remains as ambiguous and not retryable.
    expect(error.code).toBe('EXECUTION_CANCELLED_AMBIGUOUS');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('CLAIM_OWNERSHIP_LOST');
    expect(error.message).toContain('execution ownership was lost');
  });

  /**
   * The other path: the runner finished normally but the signal aborted while it was running.
   * Distinguishing this from an orderly shutdown decides who gets the incident escalated to.
   */
  it('distingue una época vencida de un apagado ordenado', async () => {
    for (const [code, message] of [
      ['STALE_EPOCH', 'Rejected epoch 3; active epoch is 4'],
      ['SHUTDOWN', 'Adapter is stopping']
    ] as const) {
      const controller = new AbortController();
      const adapter = await adapterWith({
        run: (): Promise<CommandRunResult> => {
          controller.abort(new AdapterError(code, message, false));
          return Promise.resolve({
            stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false
          });
        }
      });

      const error = await rejectionOf(adapter, controller.signal);

      expect(error.code).toBe('EXECUTION_CANCELLED_AMBIGUOUS');
      expect(error.message).toContain(code);
      expect(error.message).toContain(message);
    }
  });

  /**
   * Also describes abort reasons that are not instances of AdapterError.
   */
  it('describe también un motivo que no es AdapterError', async () => {
    const controller = new AbortController();
    const adapter = await adapterWith(runnerReturning({}));
    controller.abort(new TypeError('socket del gateway cerrado por el peer'));

    const error = await rejectionOf(adapter, controller.signal);

    expect(error.code).toBe('CANCELLED');
    expect(error.message).toContain('TypeError');
    expect(error.message).toContain('socket del gateway cerrado por el peer');
  });
});
