export class NativeAdminError extends Error {
  constructor(readonly code: 'forbidden' | 'conflict' | 'unsupported' | 'unavailable' | 'invalid_input' | 'not_found' | 'too_large' | 'unsafe_path', readonly operationId?: string) { super(code); }
}
