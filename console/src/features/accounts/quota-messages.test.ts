import { describeQuotaOperationFailure } from './quota-messages';

it('nombra la operación y la causa real que dejó el ejecutor', () => {
  const texto = describeQuotaOperationFailure({
    action: 'update_cli', error_code: 'STEP_FAILED', result: { failure_reason: 'cli_update_failed' },
  });
  expect(texto).toContain('Actualizar CLI');
  expect(texto).toContain('El comando de actualización terminó con error');
  expect(texto).not.toContain('Un paso de la operación falló');
});

it('sin causa del ejecutor, nombra la operación y dice que no dejó motivo', () => {
  const texto = describeQuotaOperationFailure({ action: 'update_cli', error_code: 'STEP_FAILED', result: null });
  expect(texto).toContain('Actualizar CLI');
  expect(texto).toContain('no dejó un motivo');
  expect(texto).not.toContain('Un paso de la operación falló y no dejó salida');
});

it('otra operación también se nombra con su causa conocida', () => {
  const texto = describeQuotaOperationFailure({
    action: 'query', error_code: 'STEP_FAILED', result: { failure_reason: 'environment_not_running' },
  });
  expect(texto).toContain('Consultar cuotas');
  expect(texto).toContain('no está en ejecución');
});
