import { describe, expect, it } from 'vitest';
import { OperationGuard } from '../server/security.js';
import { validateGeneration, validateVariations } from '../server/app.js';
import { LIMITS } from '../shared/types.js';

describe('operation ownership and validation', () => {
  it('holds the operation guard until all cancellation cleanup is finished', async () => {
    const guard = new OperationGuard();
    const operation = guard.acquire('operation-1');
    expect(() => guard.acquire('operation-2')).toThrow('Another operation');
    let cancelled = false;
    const cancellation = guard.cancel('operation-1').then(() => { cancelled = true; });
    expect(operation.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(cancelled).toBe(false);
    operation.finish();
    await cancellation;
    const next = guard.acquire('operation-2');
    operation.finish();
    expect(() => guard.acquire('operation-3')).toThrow();
    next.finish();
    guard.acquire('operation-3').finish();
  });

  it('does not let cancellation of an old ID abort a new operation', async () => {
    const guard = new OperationGuard();
    const current = guard.acquire('current');
    await guard.cancel('old');
    expect(current.signal.aborted).toBe(false);
    guard.shutdown();
    expect(current.signal.aborted).toBe(true);
    current.finish();
  });

  it('accepts only operation-specific bounded requests and three distinct placeholders', () => {
    const valid = { operationId: 'op-1', sessionId: 'session-1', prompt: ' A material-first design ', artifactIds: ['a', 'b', 'c'] };
    expect(validateGeneration(valid).prompt).toBe('A material-first design');
    expect(() => validateGeneration({ ...valid, artifactIds: ['a', 'a', 'b'] })).toThrow('distinct');
    expect(() => validateGeneration({ ...valid, artifactIds: ['a', 'b'] })).toThrow();
    expect(() => validateGeneration({ ...valid, operationId: '../escape' })).toThrow();
    expect(() => validateGeneration({ ...valid, prompt: 'x'.repeat(LIMITS.prompt + 1) })).toThrow();
    expect(() => validateGeneration({ ...valid, prompt: '' })).toThrow();
    expect(() => validateVariations({ ...valid, artifactId: 'a', html: 'x'.repeat(LIMITS.html + 1) })).toThrow();
  });
});
