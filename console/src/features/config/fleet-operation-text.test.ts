import { expect, it } from 'vitest';
import { fleetCapabilityReasonText } from './fleet-operation-text';

it('explains an unconfigured executor in Spanish without echoing the code', () => {
  const text = fleetCapabilityReasonText('executor_unconfigured');
  expect(text).toContain('no está configurado en el servidor');
  expect(text).not.toContain('executor_unconfigured');
});

it('explains an unsupported executor schema in Spanish without echoing the code', () => {
  const text = fleetCapabilityReasonText('unsupported_schema');
  expect(text).toContain('esquema que esta consola no admite');
  expect(text).not.toContain('unsupported_schema');
});

it('keeps an unknown capability code visible for support', () => {
  expect(fleetCapabilityReasonText('future_reason')).toContain('Código: future_reason');
});

it('explains a missing capability reason in Spanish', () => {
  expect(fleetCapabilityReasonText(undefined)).toContain('no detalló el motivo');
});
