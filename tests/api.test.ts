import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createLocalApp, type AppOptions } from '../server/app.js';
import { ConnectionError } from '../server/connection.js';
import type { CompletionRequest, ProviderClient } from '../server/providers.js';
import type { Bootstrap, GenerationEvent } from '../shared/types.js';
import { LIMITS } from '../shared/types.js';
import { readSse } from '../shared/stream.js';
import { MemoryStore, saved, settings } from './helpers.js';

const running: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(running.splice(0).map((close) => close())); });

async function local(options: Partial<Omit<AppOptions, 'origin'>> = {}) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test address');
  const origin = `http://127.0.0.1:${address.port}`;
  const calls: CompletionRequest[] = [];
  const provider: ProviderClient = {
    async complete(request) {
      calls.push(request);
      return request.user === 'Reply OK.' ? 'OK' : '["Chalk & Paper","Liquid Metal","Woven Light"]';
    },
    async *stream(request) {
      calls.push(request);
      request.signal.throwIfAborted();
      yield '<!doctype html><html><body><button>Test interaction</button></body></html>';
    },
  };
  const store = options.store ?? new MemoryStore(saved);
  const app = createLocalApp({ origin, store, providerFactory: () => provider, ...options });
  server.on('request', app.app);
  running.push(async () => {
    app.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as Bootstrap;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-UI-Maker-Token': bootstrap.csrfToken };
  const post = (path: string, body: unknown, extra: RequestInit = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), ...extra,
  });
  return { origin, headers, bootstrap, post, store, calls };
}

async function events(response: globalThis.Response): Promise<GenerationEvent[]> {
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const result: GenerationEvent[] = [];
  for await (const event of readSse(response.body!)) result.push(JSON.parse(event.data));
  return result;
}

const generation = { operationId: 'operation-test', sessionId: 'session-test', artifactIds: ['artifact-a', 'artifact-b', 'artifact-c'], prompt: 'Build a study timer' };

describe('loopback request security', () => {
  it('bootstraps only non-secret metadata, never enables CORS, and disables API caching', async () => {
    const app = await local();
    const response = await fetch(`${app.origin}/api/bootstrap`);
    const encoded = await response.text();
    expect(encoded).not.toContain(saved.key);
    expect(JSON.parse(encoded).connection.hasKey).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(app.calls).toHaveLength(0);
  });

  it.each(['https://evil.example', 'null', 'http://localhost:3000'])('rejects hostile Origin %s', async (origin) => {
    const app = await local();
    const response = await fetch(`${app.origin}/api/bootstrap`, { headers: { Origin: origin } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(app.bootstrap.csrfToken);
  });

  it('rejects hostile Host and cross-site fetch metadata before exposing a token', async () => {
    const app = await local();
    const hostile = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${app.origin}/api/bootstrap`, { headers: { Host: 'rebound.evil.example' } }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      });
      request.on('error', reject);
      request.end();
    });
    expect(hostile.status).toBe(403);
    expect(hostile.body).not.toContain(app.bootstrap.csrfToken);
    expect((await fetch(`${app.origin}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });

  it('requires exact Origin, JSON and the process token for every mutation', async () => {
    const app = await local();
    expect((await app.post('/api/ideas', { operationId: 'ideas' }, { headers: { Origin: app.origin, 'Content-Type': 'application/json' } })).status).toBe(403);
    expect((await app.post('/api/ideas', { operationId: 'ideas' }, { headers: { ...app.headers, 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await app.post('/api/ideas', { operationId: 'ideas' }, { headers: { ...app.headers, Origin: 'null' } })).status).toBe(403);
    expect((await app.post('/api/ideas', { operationId: 'ideas' }, { headers: { 'Content-Type': 'application/json', 'X-UI-Maker-Token': app.bootstrap.csrfToken } })).status).toBe(403);
    expect((await app.post('/api/ideas', { operationId: 'ideas' }, { headers: { ...app.headers, 'X-UI-Maker-Token': 'x'.repeat(43) } })).status).toBe(403);
    expect(app.calls).toHaveLength(0);
  });

  it('bounds bodies and returns safe JSON errors for malformed input and unknown routes', async () => {
    const app = await local();
    const malformed = await app.post('/api/ideas', {}, { body: '{invalid' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'The request body must be valid JSON.' });
    expect((await app.post('/api/ideas', { huge: 'x'.repeat(LIMITS.requestBytes) })).status).toBe(413);
    expect((await app.post('/api/proxy', { url: 'https://unrestricted.example' })).status).toBe(404);
    expect(app.calls).toHaveLength(0);
  });
});

describe('operation-specific API', () => {
  it('performs one planning call and three isolated candidate streams with a terminal event', async () => {
    const app = await local();
    const response = await app.post('/api/generate', generation);
    const output = await events(response);
    expect(app.calls).toHaveLength(4);
    expect(output.filter((event) => event.type === 'artifact-done')).toHaveLength(3);
    expect(output.at(-1)).toEqual({ type: 'done', operationId: generation.operationId, status: 'complete' });
    expect(JSON.stringify(output)).not.toContain(saved.key);
  });

  it('tests draft settings explicitly without saving them or requiring model discovery', async () => {
    const app = await local();
    const response = await app.post('/api/connection/test', {
      settings: { ...settings, model: 'unsaved-draft' }, key: { action: 'replace', value: 'unsaved-fake-key' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toContain('not been saved');
    expect(await app.store.read()).toEqual(saved);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].maxTokens).toBe(32);
  });

  it('reports failed deletion and corrupt storage without pretending the key was forgotten', async () => {
    const store = new MemoryStore(saved);
    store.forget = async () => { throw new ConnectionError('Deletion failed; saved key remains.'); };
    const app = await local({ store });
    const response = await app.post('/api/connection', {}, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('saved key remains');
    expect((await app.store.read())?.key).toBe(saved.key);
    store.read = async () => { throw new ConnectionError('The connection is corrupt.'); };
    const bootstrap = await (await fetch(`${app.origin}/api/bootstrap`)).json() as Bootstrap;
    expect(bootstrap.storageError).toContain('corrupt');
    expect(bootstrap.connection.hasKey).toBe(false);
    expect((await app.post('/api/generate', generation)).status).toBe(500);
  });

  it('does not start a model call without a saved connection', async () => {
    const app = await local({ store: new MemoryStore() });
    expect((await app.post('/api/generate', generation)).status).toBe(409);
    expect(app.calls).toHaveLength(0);
  });

  it('blocks connection changes and second operations until explicit cancellation settles', async () => {
    let aborted = false;
    const app = await local({ providerFactory: () => ({
      complete: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      }),
      async *stream() { throw new Error('Fan-out must not happen'); },
    }) });
    const response = await app.post('/api/generate', generation);
    expect((await app.post('/api/connection', { settings, key: { action: 'replace', value: 'new-fake-key' } })).status).toBe(409);
    expect((await app.post('/api/ideas', { operationId: 'second' })).status).toBe(409);
    expect((await app.post('/api/connection/test', { settings, key: { action: 'keep' } })).status).toBe(409);
    const cancelled = await app.post(`/api/operations/${generation.operationId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(aborted).toBe(true);
    const output = await events(response);
    expect(output.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
    expect((await app.post('/api/connection', { settings, key: { action: 'keep' } })).status).toBe(200);
  });

  it('propagates browser disconnect to upstream work and releases the guard', async () => {
    let notify!: () => void;
    const aborted = new Promise<void>((resolve) => { notify = resolve; });
    const app = await local({ providerFactory: () => ({
      complete: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { notify(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      }),
      async *stream() { throw new Error('Fan-out must not happen'); },
    }) });
    const response = await app.post('/api/generate', generation);
    await response.body!.cancel();
    await aborted;
    await app.post(`/api/operations/${generation.operationId}/cancel`, {});
    expect((await app.post('/api/connection', { settings, key: { action: 'keep' } })).status).toBe(200);
  });
});
