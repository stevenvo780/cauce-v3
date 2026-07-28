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
 * Observabilidad del harness: qué llega a `last_error` cuando una entrega muere.
 *
 * Las dos fallas que cubre esta suite hicieron indiagnosticable el incidente del 2026-07-27
 * (un mensaje de Telegram que derivó en 2801 entregas en 35 h): el recorte de stderr a 100
 * bytes se comía la causa, y el motivo del aborto se descartaba y dejaba una frase idéntica
 * para cinco causas distintas.
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

/** Corre el adaptador exigiendo que falle, y devuelve el AdapterError tipado. */
async function rejectionOf(adapter: HarnessAdapter, signal: AbortSignal): Promise<AdapterError> {
  try {
    await adapter.execute({ prompt: 'ejecutar una vez', timeoutMs: 2_000, signal });
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('se esperaba que el harness fallara');
}

/** El harness falla y devuelve la causa por stderr; capturamos el AdapterError resultante. */
async function failureFor(stderr: string, exitCode = 1): Promise<AdapterError> {
  const adapter = await adapterWith(runnerReturning({ stdout: 'no-structured-output', stderr, exitCode }));
  return rejectionOf(adapter, new AbortController().signal);
}

describe('causa real del fallo del harness en last_error', () => {
  /**
   * El caso literal del incidente. La primera línea sola ya pasa los 100 bytes del recorte
   * viejo, así que la SEGUNDA —la única que nombra la clave culpable— desaparecía entera y el
   * operador se quedaba con "expected one of..." y ningún lugar dónde mirar.
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
   * Cuando la causa NO entra en el presupuesto, lo que se conserva son las DOS puntas. El
   * recorte viejo se quedaba con `lines.slice(0, 3)` recortadas a 100 bytes: en un stack o en
   * un error con "caused by" al final, eso tiraba justo la parte que identifica el problema.
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
    // El detalle sigue holgadamente por debajo del tope de 2000 de `BaseAckSchema.error`,
    // que es lo que hacía que un mensaje largo tirara la conexión del adaptador.
    expect(error.message.length).toBeLessThan(2_000);
  });

  /**
   * Ampliar el presupuesto no amplía la superficie de fuga: la redacción corre ANTES del
   * recorte, así que un secreto que caiga en la cola recién conservada ya viene tapado.
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

  it('no inventa detalle cuando el harness no escribió nada en stderr', async () => {
    const error = await failureFor('   \n  \n');

    expect(error.code).toBe('PROCESS_EXIT_AMBIGUOUS');
    expect(error.message).toContain('completion state is unknown');
  });
});

describe('motivo del aborto en last_error', () => {
  /**
   * "Harness transport was cancelled after dispatch" apareció 28 veces en 24 h, en ráfagas
   * simultáneas multi-alias, sin decir jamás por qué. El motivo estaba ahí, en `signal.reason`,
   * y se tiraba.
   */
  it('propaga el motivo cuando el runner reporta la cancelación', async () => {
    const controller = new AbortController();
    // El aborto ocurre DURANTE la corrida: el proceso ya se despachó, así que el estado de
    // completitud es genuinamente ambiguo. Abortar antes de `execute` es otro camino, y ahí sí
    // se devuelve el motivo crudo porque no se gastó nada todavía.
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

    // El código NO cambia a propósito: sacar la entrega de la lista de códigos ambiguos la
    // habilitaría a reintentar trabajo ya ejecutado, que es la multiplicación del incidente.
    expect(error.code).toBe('EXECUTION_CANCELLED_AMBIGUOUS');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('CLAIM_OWNERSHIP_LOST');
    expect(error.message).toContain('execution ownership was lost');
  });

  /**
   * El otro camino: el runner terminó normalmente pero la señal se abortó mientras corría.
   * Distinguir esto de un apagado ordenado decide a quién se escala el incidente.
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
   * Un aborto cuyo motivo no es un `AdapterError` tampoco puede quedar mudo: antes caía en la
   * frase genérica de `abortReason` y perdía el único dato disponible.
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
