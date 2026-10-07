import { describe, expect, it, vi } from 'vitest';
import { runGeneration, runIdeas, runVariations } from '../server/generation.js';
import { registerSecret } from '../shared/diagnostics.js';
import { ProviderError } from '../server/providers.js';
import type { CompletionRequest, ProviderClient } from '../server/providers.js';
import { HTML_SYSTEM, IDEAS_SYSTEM, OUTPUT_MAX_CHARS, OUTPUT_MIN_CHARS, PLAN_SYSTEM, VARIATIONS_SYSTEM } from '../server/prompts.js';
import { LIMITS } from '../shared/types.js';
import type { GenerationEvent, GenerationRequest, TraceEntry, VariationsRequest } from '../shared/types.js';

const names = ['Paper Layers', 'Chrome Etching', 'Kinetic Grid'];
const request = (): GenerationRequest => ({ operationId: 'operation-1', sessionId: 'source-session', prompt: 'A museum guide', artifactIds: ['artifact-1', 'artifact-2', 'artifact-3'] });
const variationRequest = (): VariationsRequest => ({ operationId: 'variation-op', sessionId: 'source-session', artifactId: 'source-artifact', prompt: 'A museum guide', html: '<html>original</html>' });
const variations = ['Ink', 'Glass', 'Wire'].map((name) => JSON.stringify({ name, html: `<html>${name}</html>` }));
const signal = () => new AbortController().signal;

function client() {
  return {
    complete: vi.fn<ProviderClient['complete']>(async () => JSON.stringify(names)),
    stream: vi.fn<ProviderClient['stream']>(async function* () { yield '<html>complete</html>'; }),
  };
}

function capture() {
  const events: GenerationEvent[] = [];
  return { events, emit: async (event: GenerationEvent) => { events.push(event); } };
}

function done(events: GenerationEvent[], status: string, operationId: string): void {
  expect(events.filter((event) => event.type === 'done')).toEqual([{ type: 'done', operationId, status }]);
  expect(events.at(-1)).toEqual({ type: 'done', operationId, status });
  expect(events.every((event) => event.operationId === operationId)).toBe(true);
}

describe('generation orchestration', () => {
  it('plans once, streams one artifact at a time in order, preserves deltas, and finishes after all artifacts', async () => {
    const provider = client();
    const { events, emit } = capture();
    const input = request();
    const abortSignal = signal();
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    provider.stream.mockImplementation(async function* (completion) {
      expect(events[0]).toMatchObject({ type: 'plan', names });
      expect(completion.signal).toBe(abortSignal);
      started++;
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        yield '```html\n<html><script>const code = "```";</script>';
        yield '</html>\n```';
      } finally {
        inFlight--;
      }
    });
    await runGeneration(provider, input, abortSignal, emit);
    expect(provider.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxTokens: 256, signal: abortSignal, system: PLAN_SYSTEM }));
    expect(provider.stream).toHaveBeenCalledTimes(3);
    expect(started).toBe(3);
    expect(maxInFlight).toBe(1);
    expect(provider.stream.mock.calls.map(([completion]) => completion.user)).toEqual(names.map((name) => expect.stringContaining(name)));
    expect(events.filter((event) => event.type === 'artifact-delta')).toHaveLength(6);
    expect(events.filter((event) => event.type === 'artifact-done')).toEqual(input.artifactIds.map((artifactId) => ({
      type: 'artifact-done', operationId: input.operationId, sessionId: input.sessionId, artifactId,
      html: '<html><script>const code = "```";</script></html>',
    })));
    done(events, 'complete', input.operationId);
  });

  it('redacts credentials, labels, and clips traced provider text for the inspector', async () => {
    const secret = 'sk-live-super-secret-value';
    registerSecret(secret);
    const provider = client();
    const entries: TraceEntry[] = [];
    const long = secret + 'x'.repeat(LIMITS.traceChars + 50);
    provider.complete.mockImplementation(async (input: CompletionRequest) => {
      input.trace?.({ dir: 'in', channel: 'request', text: long });
      return JSON.stringify(names);
    });
    provider.stream.mockImplementation(async function* (input: CompletionRequest) {
      input.trace?.({ dir: 'out', channel: 'frame', text: `${secret}<html>ok</html>` });
      yield '<html>ok</html>';
    });
    await runGeneration(provider, request(), signal(), async () => undefined, (entry) => entries.push(entry));
    const outbound = entries.find((entry) => entry.dir === 'in');
    expect(outbound).toMatchObject({ phase: 'plan', channel: 'request', label: 'plan' });
    expect(outbound!.text).not.toContain(secret);
    expect(outbound!.text).toContain('[redacted]');
    expect(outbound!.text.length).toBe(LIMITS.traceChars);
    expect(outbound!.truncated).toBe(true);
    const frame = entries.find((entry) => entry.channel === 'frame');
    expect(frame).toMatchObject({ dir: 'out', phase: 'generate', artifactId: 'artifact-1' });
    expect(frame!.text).not.toContain(secret);
    expect(frame!.text).toContain('<html>ok</html>');
  });

  it.each(['not JSON', '["one","two"]', '[1,2,3]', '["Ink","ink","Glass"]', '["", "Glass", "Paper"]'])('falls back only for malformed names: %s', async (plan) => {
    const provider = client();
    provider.complete.mockResolvedValue(plan);
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(events[0]).toMatchObject({ type: 'warning', sessionId: 'source-session' });
    expect(events[1]).toMatchObject({ type: 'plan', names: ['Layered Paper', 'Etched Metal', 'Kinetic Wireframe'] });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(provider.stream).toHaveBeenCalledTimes(3);
    done(events, 'complete', 'operation-1');
  });

  it('accepts a properly fenced JSON plan without falling back', async () => {
    const provider = client();
    provider.complete.mockResolvedValue('```json\n' + JSON.stringify(names) + '\n```');
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(events[0]).toMatchObject({ type: 'plan', names });
    expect(events.some((event) => event.type === 'warning')).toBe(false);
    done(events, 'complete', 'operation-1');
  });

  it.each(['error', 'incomplete', 'cancelled'] as const)('does not fan out or fall back after a planning %s', async (status) => {
    const provider = client();
    provider.complete.mockRejectedValue(new ProviderError(status, 'Controlled provider failure.'));
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'artifact-error')).toEqual(request().artifactIds.map((artifactId) => ({
      type: 'artifact-error', operationId: 'operation-1', sessionId: 'source-session', artifactId, status, message: 'Controlled provider failure.',
    })));
    expect(events.some((event) => event.type === 'plan' || event.type === 'warning')).toBe(false);
    done(events, status, 'operation-1');
  });

  it('normalizes unexpected planning errors and does not treat an empty plan as success', async () => {
    for (const response of [new Error('secret transport internals'), '']) {
      const provider = client();
      if (response instanceof Error) provider.complete.mockRejectedValue(response);
      else provider.complete.mockResolvedValue(response);
      const { events, emit } = capture();
      await runGeneration(provider, request(), signal(), emit);
      expect(provider.stream).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'artifact-error')).toHaveLength(3);
      expect(JSON.stringify(events)).not.toContain('secret transport internals');
      done(events, 'error', 'operation-1');
    }
  });

  it('isolates failures, retains emitted partial source, and keeps successful siblings', async () => {
    const provider = client();
    let index = 0;
    provider.stream.mockImplementation(async function* () {
      const artifact = index++;
      if (artifact === 0) {
        yield '<html>partial';
        throw new ProviderError('incomplete', 'Interrupted before the terminal event.');
      }
      if (artifact === 1) { yield '<html>complete</html>'; return; }
      throw new Error('private network details');
    });
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(events).toContainEqual({ type: 'artifact-delta', operationId: 'operation-1', sessionId: 'source-session', artifactId: 'artifact-1', delta: '<html>partial' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact-error', artifactId: 'artifact-1', status: 'incomplete' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact-done', artifactId: 'artifact-2', html: '<html>complete</html>' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact-error', artifactId: 'artifact-3', status: 'error' }));
    expect(events.filter((event) => event.type === 'artifact-done')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('private network details');
    done(events, 'incomplete', 'operation-1');
  });

  it.each(['', '   ', 'I cannot provide this.', '```html\n\n```'])('rejects unusable HTML after an otherwise successful stream', async (html) => {
    const provider = client();
    provider.stream.mockImplementation(async function* () { yield html; });
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(events.filter((event) => event.type === 'artifact-error')).toHaveLength(3);
    expect(events.some((event) => event.type === 'artifact-done')).toBe(false);
    done(events, 'error', 'operation-1');
  });

  it('bounds each artifact and closes its iterator while retaining earlier deltas', async () => {
    const provider = client();
    let cleaned = 0;
    provider.stream.mockImplementation(async function* () {
      try { yield '<html>partial'; yield 'x'.repeat(LIMITS.html); }
      finally { cleaned++; }
    });
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(cleaned).toBe(3);
    expect(events.filter((event) => event.type === 'artifact-delta')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'artifact-error').every((event) => event.status === 'incomplete')).toBe(true);
    done(events, 'incomplete', 'operation-1');
  });

  it('isolates JSON-escaped final events that exceed the transport limit despite fitting the HTML limit', async () => {
    const provider = client();
    let index = 0;
    provider.stream.mockImplementation(async function* () {
      if (index++ === 0) {
        yield '<html>';
        yield '"'.repeat(Math.ceil(LIMITS.sseEvent / 4) + 256);
        yield '"'.repeat(Math.ceil(LIMITS.sseEvent / 4) + 256);
        yield '</html>';
      } else yield '<html>complete sibling</html>';
    });
    const { events, emit } = capture();
    await runGeneration(provider, request(), signal(), emit);
    expect(events.every((event) => JSON.stringify(event).length <= LIMITS.sseEvent)).toBe(true);
    expect(events.filter((event) => event.type === 'artifact-done')).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'artifact-error', artifactId: 'artifact-1', status: 'incomplete', message: expect.stringContaining('event size') }));
    done(events, 'incomplete', 'operation-1');
  });

  it.each(['before', 'planning', 'fallback-warning'] as const)('marks every placeholder cancelled when stopped %s', async (when) => {
    const abort = new AbortController();
    const provider = client();
    const { events, emit } = capture();
    if (when === 'before') abort.abort();
    if (when === 'planning') provider.complete.mockImplementation(async () => { abort.abort(); return JSON.stringify(names); });
    if (when === 'fallback-warning') provider.complete.mockResolvedValue('malformed');
    await runGeneration(provider, request(), abort.signal, async (event) => {
      await emit(event);
      if (event.type === 'warning') abort.abort();
    });
    expect(provider.stream).not.toHaveBeenCalled();
    if (when === 'before') expect(provider.complete).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'artifact-error')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'artifact-error').every((event) => event.status === 'cancelled')).toBe(true);
    done(events, 'cancelled', 'operation-1');
  });

  it('stops the in-flight stream without late deltas/completions and keeps captured IDs', async () => {
    const abort = new AbortController();
    const provider = client();
    const input = request();
    const { events, emit } = capture();
    let started = 0;
    let cleaned = 0;
    provider.stream.mockImplementation(async function* () {
      started++;
      try { yield '<html>partial'; yield 'must not arrive</html>'; }
      finally { cleaned++; }
    });
    await runGeneration(provider, input, abort.signal, async (event) => {
      if (event.type === 'artifact-delta') {
        input.sessionId = 'new-selected-session';
        input.artifactIds[0] = 'changed-placeholder';
        abort.abort();
      }
      await emit(event);
    });
    expect(started).toBe(1);
    expect(cleaned).toBe(1);
    expect(events.filter((event) => event.type === 'artifact-delta')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'artifact-error')).toEqual(['artifact-1', 'artifact-2', 'artifact-3'].map((artifactId) => ({
      type: 'artifact-error', operationId: 'operation-1', sessionId: 'source-session', artifactId, status: 'cancelled', message: 'The request was cancelled.',
    })));
    expect(events.some((event) => event.type === 'artifact-done')).toBe(false);
    expect(events.every((event) => !('sessionId' in event) || event.sessionId === 'source-session')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('changed-placeholder');
    done(events, 'cancelled', 'operation-1');
  });
});

describe('variation orchestration', () => {
  it('emits each validated record immediately with stable UUIDs and captured source session', async () => {
    const provider = client();
    const input = variationRequest();
    const { events, emit } = capture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first!: () => void;
    const firstEvent = new Promise<void>((resolve) => { first = resolve; });
    provider.stream.mockImplementation(async function* (completion) {
      expect(completion.user).toContain('<html>original</html>');
      yield variations[0];
      await gate;
      yield variations.slice(1).join('\n');
    });
    const running = runVariations(provider, input, signal(), async (event) => {
      await emit(event);
      if (event.type === 'variation') {
        input.sessionId = 'new-session';
        input.operationId = 'new-operation';
        first();
      }
    });
    await firstEvent;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'variation', sessionId: 'source-session', artifact: { styleName: 'Ink', status: 'complete' } });
    release();
    await running;
    const records = events.filter((event) => event.type === 'variation');
    expect(records).toHaveLength(3);
    expect(new Set(records.map((event) => event.artifact.id)).size).toBe(3);
    for (const event of records) {
      expect(event.artifact.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event.sessionId).toBe('source-session');
      expect(event.artifact.status).toBe('complete');
    }
    expect(provider.complete).not.toHaveBeenCalled();
    expect(provider.stream).toHaveBeenCalledOnce();
    done(events, 'complete', 'variation-op');
  });

  it.each(['\n{bad}', '\n{"name":"cut off', '\ntrailing prose', ''])('keeps valid records before malformed, truncated, or too-short output %j', async (tail) => {
    const provider = client();
    provider.stream.mockImplementation(async function* () { yield variations[0] + tail; });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), signal(), emit);
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', sessionId: 'source-session', artifactId: 'source-artifact' }));
    done(events, 'incomplete', 'variation-op');
  });

  it('accepts at most three records and warns instead of discarding them on a fourth', async () => {
    const provider = client();
    provider.stream.mockImplementation(async function* () { yield variations.join('\n') + '\n' + variations[0]; });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), signal(), emit);
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(3);
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    done(events, 'incomplete', 'variation-op');
  });

  it('checks normalized variation event size before calling the shared API writer', async () => {
    const provider = client();
    const overhead = JSON.stringify({ name: 'Wide', html: '<html></html>' }).length;
    const html = '<html>' + '"'.repeat(Math.floor((LIMITS.variationBuffer - overhead) / 2)) + '</html>';
    const raw = JSON.stringify({ name: 'Wide', html });
    expect(raw.length).toBeLessThanOrEqual(LIMITS.variationBuffer);
    expect(html.length).toBeLessThan(LIMITS.html);
    provider.stream.mockImplementation(async function* () { yield variations[0]; yield raw; });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), signal(), emit);
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(1);
    expect(events.every((event) => JSON.stringify(event).length <= LIMITS.sseEvent)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', message: expect.stringContaining('event size') }));
    done(events, 'incomplete', 'variation-op');
  });

  it('does not turn complete records into operation success after a provider disconnect', async () => {
    const provider = client();
    provider.stream.mockImplementation(async function* () {
      yield variations.join('\n');
      throw new ProviderError('incomplete', 'Missing the protocol terminal.');
    });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), signal(), emit);
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', message: 'Missing the protocol terminal.' }));
    done(events, 'incomplete', 'variation-op');
  });

  it('cancels on closing/applying without emitting later records from the same chunk', async () => {
    const provider = client();
    const abort = new AbortController();
    let cleaned = false;
    provider.stream.mockImplementation(async function* () {
      try { yield variations.join('\n'); }
      finally { cleaned = true; }
    });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), abort.signal, async (event) => {
      await emit(event);
      if (event.type === 'variation') abort.abort();
    });
    expect(cleaned).toBe(true);
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(1);
    done(events, 'cancelled', 'variation-op');
  });

  it.each(['', '{invalid}', JSON.stringify({ name: 'Invalid', html: 'refused' })])('reports an error when no valid record was returned: %j', async (wire) => {
    const provider = client();
    provider.stream.mockImplementation(async function* () { yield wire; });
    const { events, emit } = capture();
    await runVariations(provider, variationRequest(), signal(), emit);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events.filter((event) => event.type === 'variation')).toHaveLength(0);
    done(events, 'error', 'variation-op');
  });
});

describe('explicit ideas', () => {
  it('makes only the explicit nonstreaming request and validates an array', async () => {
    const provider = client();
    expect(provider.complete).not.toHaveBeenCalled();
    provider.complete.mockResolvedValue('```json\n["A tactile gallery", " A kinetic train board "]\n```');
    const { events, emit } = capture();
    await runIdeas(provider, { operationId: 'ideas-op' }, signal(), emit);
    expect(provider.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ system: IDEAS_SYSTEM, maxTokens: 1536 }));
    expect(provider.stream).not.toHaveBeenCalled();
    expect(events[0]).toEqual({ type: 'ideas', operationId: 'ideas-op', ideas: ['A tactile gallery', 'A kinetic train board'] });
    done(events, 'complete', 'ideas-op');
  });

  it.each(['{}', '[]', '[1]', '["", "other"]', '["same", "SAME"]', JSON.stringify(['x'.repeat(241)]), JSON.stringify(Array.from({ length: 21 }, (_, i) => `Idea ${i}`))])('rejects invalid ideas %s', async (raw) => {
    const provider = client();
    provider.complete.mockResolvedValue(raw);
    const { events, emit } = capture();
    await runIdeas(provider, { operationId: 'ideas-op' }, signal(), emit);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events.some((event) => event.type === 'ideas')).toBe(false);
    done(events, 'error', 'ideas-op');
  });

  it('never emits stale ideas after cancellation and does not reflect unexpected errors', async () => {
    const abort = new AbortController();
    const provider = client();
    provider.complete.mockImplementation(async (_request: CompletionRequest) => { abort.abort(); return '["late"]'; });
    const { events, emit } = capture();
    await runIdeas(provider, { operationId: 'ideas-op' }, abort.signal, emit);
    expect(events.some((event) => event.type === 'ideas')).toBe(false);
    done(events, 'cancelled', 'ideas-op');
    const errors = capture();
    provider.complete.mockRejectedValue(new Error('sensitive internals'));
    await runIdeas(provider, { operationId: 'ideas-op' }, signal(), errors.emit);
    expect(JSON.stringify(errors.events)).not.toContain('sensitive internals');
    done(errors.events, 'error', 'ideas-op');
  });
});

describe('design prompt invariants', () => {
  it('preserves material-first, typography, IP safety, bold layouts, and reduced motion', () => {
    for (const prompt of [PLAN_SYSTEM, HTML_SYSTEM, VARIATIONS_SYSTEM, IDEAS_SYSTEM]) {
      expect(prompt).toContain('material-first');
      expect(prompt).toContain('typography');
      expect(prompt).toContain('brand');
      expect(prompt).toContain('bold');
      expect(prompt).toContain('prefers-reduced-motion');
    }
    for (const prompt of [HTML_SYSTEM, VARIATIONS_SYSTEM]) {
      expect(prompt).toContain('self-contained HTML');
      expect(prompt).toContain('No remote fonts');
      expect(prompt).toContain('dependencies');
      expect(prompt).toContain('desktop and mobile');
      expect(prompt).toContain(`${OUTPUT_MIN_CHARS} and ${OUTPUT_MAX_CHARS} characters`);
    }
  });
});
