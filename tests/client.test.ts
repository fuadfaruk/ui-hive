import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generationEvents, parseGenerationEvent } from '../src/api.js';
import { ArtifactPreview, previewDocument } from '../src/components/ArtifactPreview.js';
import { exportFilename, sourceForExport } from '../src/components/SourceDrawer.js';
import type { Artifact } from '../shared/types.js';
import { LIMITS } from '../shared/types.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('client stream validation', () => {
  it.each([
    '{', 'null', '{}',
    JSON.stringify({ type: 'done', operationId: 'op', status: ['complete'] }),
    JSON.stringify({ type: 'done', operationId: 'op', status: 'optimistic-success' }),
    JSON.stringify({ type: 'artifact-delta', operationId: 'op', sessionId: 'session', delta: '<html>' }),
    JSON.stringify({ type: 'plan', operationId: 'op', sessionId: 'session', names: ['only', 'two'] }),
    JSON.stringify({ type: 'variation', operationId: 'op', sessionId: 'session', artifact: { id: 'a', styleName: 'Paper', html: '<html>', status: ['complete'] } }),
    JSON.stringify({ type: 'trace', operationId: 'op', entry: { at: 1, dir: 'sideways', channel: 'frame', phase: 'plan', label: 'plan', text: 'x' } }),
    JSON.stringify({ type: 'trace', operationId: 'op', entry: { at: 1, dir: 'in', channel: 'frame', phase: 'plan', label: 'plan', text: 'x'.repeat(LIMITS.traceChars + 1) } }),
    JSON.stringify({ type: 'trace', operationId: 'op', entry: { at: 'soon', dir: 'in', channel: 'request', phase: 'plan', label: 'plan', text: 'x' } }),
  ])('rejects a malformed normalized stream event: %s', (data) => {
    expect(() => parseGenerationEvent(data)).toThrow();
  });

  it('accepts a bounded development trace entry', () => {
    const entry = { at: 123, dir: 'out', channel: 'frame', phase: 'generate', label: 'Layered Paper', text: 'data: {"choices":[]}', artifactId: 'artifact' };
    expect(parseGenerationEvent(JSON.stringify({ type: 'trace', operationId: 'op', entry }))).toEqual({ type: 'trace', operationId: 'op', entry });
  });

  it('accepts explicit terminal outcomes and bounded partial source without executing it', () => {
    for (const status of ['complete', 'incomplete', 'error', 'cancelled']) {
      expect(parseGenerationEvent(JSON.stringify({ type: 'done', operationId: 'op', status }))).toEqual({ type: 'done', operationId: 'op', status });
    }
    expect(parseGenerationEvent(JSON.stringify({ type: 'artifact-delta', operationId: 'op', sessionId: 'session', artifactId: 'artifact', delta: '<script>throw 42</script>' }))).toMatchObject({ delta: '<script>throw 42</script>' });
    expect(() => parseGenerationEvent(JSON.stringify({ type: 'artifact-delta', operationId: 'op', sessionId: 'session', artifactId: 'artifact', delta: 'x'.repeat(LIMITS.html + 1) }))).toThrow();
  });

  it('sends only operation input and the token to the same-origin endpoint, without retries', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const fetcher = vi.fn(async () => new Response('data: {"type":"done","operationId":"op","status":"complete"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const events = [];
    for await (const event of generationEvents('ideas', 'local-test-token', { operationId: 'op' }, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ type: 'done', operationId: 'op', status: 'complete' }]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/ideas', expect.objectContaining({
      method: 'POST', mode: 'same-origin', redirect: 'error', credentials: 'same-origin', cache: 'no-store',
      body: '{"operationId":"op"}', headers: expect.objectContaining({ 'X-UI-Maker-Token': 'local-test-token' }),
    }));
  });

  it('rejects cross-operation output instead of attaching it to the current design', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"done","operationId":"old-op","status":"complete"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
    await expect(async () => {
      for await (const _ of generationEvents('ideas', 'token', { operationId: 'current-op' }, new AbortController().signal)) { /* Drain the rejected response. */ }
    }).rejects.toThrow('different operation');
  });
});

describe('opaque preview and safe export', () => {
  const artifact: Artifact = { id: 'a', styleName: '../../CON : Cafe / Paper', html: '<!doctype html><html><body><script>parent.document.body.remove()</script></body></html>', status: 'complete' };

  it('puts the network-free policy before every untrusted element', () => {
    const document = previewDocument(artifact.html);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf(artifact.html));
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).not.toContain('https://');
  });

  it('gives preview iframes only script permission, with no shared-origin capability', () => {
    for (const interactive of [false, true]) {
      const rendered = renderToStaticMarkup(createElement(ArtifactPreview, { artifact, interactive }));
      expect(rendered).toContain('sandbox="allow-scripts"');
      expect(rendered).not.toContain('allow-same-origin');
      expect(rendered).not.toContain('allow-popups');
      expect(rendered).not.toContain('allow-forms');
      expect(rendered).toContain('referrerPolicy="no-referrer"');
    }
  });

  it('normalizes filenames and clearly labels unfinished, untrusted exports', () => {
    expect(exportFilename(artifact)).toBe('uihive-con-cafe-paper.html');
    const incomplete = { ...artifact, status: 'incomplete' as const };
    expect(exportFilename(incomplete)).toBe('uihive-con-cafe-paper-incomplete.html');
    expect(sourceForExport(incomplete)).toContain('INCOMPLETE OUTPUT (incomplete)');
    expect(sourceForExport(artifact)).toContain('UNTRUSTED GENERATED HTML');
    expect(sourceForExport(artifact)).toContain(artifact.html);
    expect(sourceForExport(artifact)).not.toContain('Content-Security-Policy');
    expect(sourceForExport({ ...artifact, html: '```html\n<p>Fence removal</p>\n```' })).toContain('<p>Fence removal</p>');
    expect(sourceForExport({ ...artifact, html: '```html\n<p>Fence removal</p>\n```' })).not.toContain('```');
  });
});
