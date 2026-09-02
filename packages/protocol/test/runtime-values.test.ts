import { describe, expect, it } from 'vitest';
import {
  hasVisibleText, isLiteralTrue, isSignalAborted, objectRecord, persistedString,
  readMutableBoolean, visibleText,
} from '../src/index.js';

describe('runtime value readers', () => {
  it('trims a visible text and empties an invisible one', () => {
    expect(visibleText('  hola  ')).toBe('hola');
    expect(visibleText('   ')).toBe('');
    expect(visibleText(5)).toBe('');
  });

  it('answers visibility as a type predicate without trimming', () => {
    expect(hasVisibleText('   ')).toBe(false);
    expect(hasVisibleText('a')).toBe(true);
    expect(hasVisibleText(undefined)).toBe(false);
  });

  it('accepts only a plain object as a record', () => {
    expect(objectRecord([])).toBeUndefined();
    expect(objectRecord(null)).toBeUndefined();
    expect(objectRecord('texto')).toBeUndefined();
    expect(objectRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it('reads a persisted string', () => {
    expect(persistedString('valor')).toBe('valor');
    expect(persistedString(1)).toBeUndefined();
    expect(persistedString(null)).toBeUndefined();
  });

  it('reads booleans the type checker would otherwise narrow away', () => {
    expect(isLiteralTrue(true)).toBe(true);
    expect(isLiteralTrue('true')).toBe(false);
    expect(readMutableBoolean(false)).toBe(false);
    const controller = new AbortController();
    expect(isSignalAborted(controller.signal)).toBe(false);
    controller.abort();
    expect(isSignalAborted(controller.signal)).toBe(true);
  });
});
