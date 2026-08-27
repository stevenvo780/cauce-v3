export type StoreErrorCode =
  'forbidden' | 'no_route' | 'conflict' | 'fenced' | 'not_found' | 'invalid_actor'
  | 'invalid_input' | 'rate_limited';

export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}
