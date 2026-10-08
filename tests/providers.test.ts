import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, ProviderError } from '../server/providers.js';
import type { CompletionRequest, CompletionSummary, ProviderTraceEntry } from '../server/providers.js';
import type { SavedConnection } from '../server/connection.js';
import { LIMITS } from '../shared/types.js';

const key = 'sk-test-credential-not-real';
const encoder = new TextEncoder();
const request = (signal = new AbortController().signal): CompletionRequest => ({ system: 'System rules', user: 'User input', signal });
const connection = (protocol: 'openai' | 'anthropic' = 'openai'): SavedConnection => ({
  key,
  settings: { protocol, apiUrl: 'https://example.invalid/custom/v2/', model: 'free-form/vendor:model-2026', anthropicMaxTokens: 8192 },
});
const packet = (value: unknown, event?: string): string => `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason: unknown = 'stop') => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const openAi = (text = '<html>test</html>') => packet(delta(text)) + packet(finish()) + packet('[DONE]');
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const completion = (content = 'result', finishReason: unknown = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] });

function sseResponse(text: string, chunkSize = 13): Response {
  const data = encoder.encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < data.length; offset += chunkSize) controller.enqueue(data.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}

function anthropicPackets(text = '<html>test</html>', reason = 'end_turn'): string {
  return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason } },
    { type: 'message_stop' },
  ].map((value) => packet(value, value.type)).join('');
}

afterEach(() => vi.useRealTimers());

describe('provider requests', () => {
  it('sends the OpenAI protocol with a free-form model, preserved URL prefix, and the default token field', async () => {
    const saved = connection();
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    const client = createProvider(saved, { fetch: fetcher });
    saved.settings.model = 'changed after snapshot';
    saved.key = 'changed-key';
    expect(await client.complete({ ...request(), maxTokens: 32 })).toBe('result');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://example.invalid/custom/v2/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(new Headers(init?.headers).get('x-api-key')).toBeNull();
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'free-form/vendor:model-2026', stream: false, max_tokens: 32,
      messages: [{ role: 'system', content: 'System rules' }, { role: 'user', content: 'User input' }],
    });
    expect((init!.signal as AbortSignal).aborted).toBe(true);
  });

  it('sends an explicit temperature and omits the token field when no cap is known', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    const client = createProvider(connection(), { fetch: fetcher });
    await client.complete({ ...request(), temperature: 0.3 });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBeUndefined();
  });

  it('rejects an out-of-range temperature before any paid call', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createProvider(connection(), { fetch: fetcher });
    await expect(client.complete({ ...request(), temperature: 3 })).rejects.toMatchObject({ status: 'error' });
    await expect(client.complete({ ...request(), temperature: Number.NaN })).rejects.toMatchObject({ status: 'error' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a stream summary with finish reason, deltas, and end reason', async () => {
    const summaries: CompletionSummary[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(openAi('<html>ok</html>')));
    await collect(createProvider(connection(), { fetch: fetcher }).stream({ ...request(), summary: (info) => summaries.push(info) }));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ protocol: 'openai', streaming: true, endReason: 'done', finishReason: 'stop', reasoning: false, deltas: 1 });
    expect(summaries[0].outputChars).toBe('<html>ok</html>'.length);
  });

  it('reports a stream summary even when the provider stream fails', async () => {
    const summaries: CompletionSummary[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(packet({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + packet({ error: { message: key } })));
    const client = createProvider(connection(), { fetch: fetcher });
    await expect(collect(client.stream({ ...request(), summary: (info) => summaries.push(info) }))).rejects.toMatchObject({ status: 'error' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ streaming: true, endReason: 'error', reasoning: false, deltas: 1 });
  });

  it('reports a completion summary with the parsed finish reason', async () => {
    const summaries: CompletionSummary[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion('result', 'stop')));
    await createProvider(connection(), { fetch: fetcher }).complete({ ...request(), summary: (info) => summaries.push(info) });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ protocol: 'openai', streaming: false, endReason: 'finish_reason', finishReason: 'stop', reasoning: false, deltas: 1 });
    expect(summaries[0].outputChars).toBe('result'.length);
  });

  it('never lets a faulty summary sink fail a paid request', async () => {
    const completeFetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    expect(await createProvider(connection(), { fetch: completeFetcher }).complete({ ...request(), summary: () => { throw new Error('sink exploded'); } })).toBe('result');
    const streamFetcher = vi.fn<typeof fetch>(async () => sseResponse(openAi('result')));
    expect(await collect(createProvider(connection(), { fetch: streamFetcher }).stream({ ...request(), summary: () => { throw new Error('sink exploded'); } }))).toBe('result');
  });

  it('traces the outbound body and raw upstream frames for a streaming request', async () => {
    const traced: ProviderTraceEntry[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(openAi('<html>traced</html>')));
    const client = createProvider(connection(), { fetch: fetcher });
    expect(await collect(client.stream({ ...request(), trace: (entry) => traced.push(entry) }))).toBe('<html>traced</html>');
    const outbound = traced.filter((entry) => entry.dir === 'in');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].channel).toBe('request');
    expect(JSON.parse(outbound[0].text).messages[0]).toEqual({ role: 'system', content: 'System rules' });
    const frames = traced.filter((entry) => entry.channel === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((entry) => entry.dir === 'out')).toBe(true);
    expect(frames.map((entry) => entry.text).join('')).toContain('[DONE]');
  });

  it('traces the raw non-streaming response body when a trace sink is supplied', async () => {
    const traced: ProviderTraceEntry[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion('<html>ok</html>')));
    const client = createProvider(connection(), { fetch: fetcher });
    expect(await client.complete({ ...request(), trace: (entry) => traced.push(entry) })).toBe('<html>ok</html>');
    const response = traced.find((entry) => entry.channel === 'response');
    expect(response?.dir).toBe('out');
    expect(JSON.parse(response!.text).choices[0].message.content).toBe('<html>ok</html>');
  });

  it('never traces while a sink is absent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    const client = createProvider(connection(), { fetch: fetcher });
    expect(await client.complete(request())).toBe('result');
  });

  it.each(['max_tokens', 'max_completion_tokens'] as const)('uses only the explicitly configured %s field and caps small requests', async (field) => {    const saved = connection();
    saved.settings.apiUrl = 'https://example.invalid/prefix/chat/completions/';
    saved.settings.openaiTokenLimit = { field, value: 2048 };
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    const client = createProvider(saved, { fetch: fetcher });
    await client.complete({ ...request(), maxTokens: 16 });
    await client.complete(request());
    expect(fetcher.mock.calls[0][0]).toBe('https://example.invalid/prefix/chat/completions');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)[field]).toBe(16);
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)[field]).toBe(2048);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
  });

  it('sends Anthropic headers, top-level system, required token limit, and no vendor extras', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'result' }], stop_reason: 'end_turn' }));
    const client = createProvider(connection('anthropic'), { fetch: fetcher });
    expect(await client.complete(request())).toBe('result');
    await client.complete({ ...request(), maxTokens: 24 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://example.invalid/custom/v2/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'free-form/vendor:model-2026', system: 'System rules',
      messages: [{ role: 'user', content: 'User input' }], max_tokens: 8192, stream: false,
    });
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).max_tokens).toBe(24);
  });

  it('caps Anthropic requests to the configured limit, including streams', async () => {
    const saved = connection('anthropic');
    saved.settings.anthropicMaxTokens = 50;
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(anthropicPackets()));
    await collect(createProvider(saved, { fetch: fetcher }).stream({ ...request(), maxTokens: 100 }));
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).max_tokens).toBe(50);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).stream).toBe(true);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('accept')).toBe('text/event-stream');
  });

  it('rejects mismatched URLs and oversized requests before any paid call', async () => {
    const saved = connection();
    saved.settings.apiUrl = 'https://example.invalid/messages';
    const fetcher = vi.fn<typeof fetch>();
    expect(() => createProvider(saved, { fetch: fetcher })).toThrow(ProviderError);
    const client = createProvider(connection(), { fetch: fetcher });
    await expect(client.complete({ ...request(), user: 'x'.repeat(LIMITS.requestBytes) })).rejects.toMatchObject({ status: 'error' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('safe failures and nonstreaming validation', () => {
  it.each([301, 302, 307, 401, 403, 429, 500])('does not retry, follow redirects, or reflect HTTP %i errors', async (status) => {
    const response = new Response(`<html>Upstream echoed ${key}</html>`, { status, headers: { 'content-type': 'text/html', location: 'https://untrusted.invalid' } });
    const fetcher = vi.fn<typeof fetch>(async () => response);
    const result = await createProvider(connection(), { fetch: fetcher }).complete(request()).catch((error: ProviderError) => error);
    expect(result).toBeInstanceOf(ProviderError);
    expect((result as ProviderError).status).toBe('error');
    expect((result as ProviderError).message).not.toContain(key);
    expect((result as ProviderError).message).not.toContain('<html>');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it.each(['text/html', 'text/plain', 'text/event-stream'])('rejects non-JSON completion content type %s', async (contentType) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(key, { headers: { 'content-type': contentType } }));
    await expect(createProvider(connection(), { fetch: fetcher }).complete(request())).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('content type') });
  });

  it('requires event-stream content type for streams', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion()));
    await expect(collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).rejects.toMatchObject({ status: 'error' });
  });

  it.each([
    ['malformed JSON', '{not json', 'error'],
    ['provider error', JSON.stringify({ error: { message: key } }), 'error'],
    ['no choices', JSON.stringify({ content: 'not chat completions' }), 'error'],
    ['empty text', JSON.stringify(completion('   ')), 'error'],
    ['truncated', JSON.stringify(completion('partial', 'length')), 'incomplete'],
    ['missing finish', JSON.stringify(completion('partial', null)), 'error'],
    ['refusal', JSON.stringify({ choices: [{ message: { content: 'text', refusal: key }, finish_reason: 'stop' }] }), 'error'],
    ['tool call', JSON.stringify({ choices: [{ message: { content: 'text', tool_calls: [{}] }, finish_reason: 'stop' }] }), 'error'],
    ['multimodal content', JSON.stringify({ choices: [{ message: { content: [{ type: 'image' }] }, finish_reason: 'stop' }] }), 'error'],
  ])('rejects %s rather than calling partial text successful', async (_name, body, status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    const promise = createProvider(connection(), { fetch: fetcher }).complete(request());
    await expect(promise).rejects.toMatchObject({ status });
    await expect(promise).rejects.not.toHaveProperty('message', expect.stringContaining(key));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['max_tokens', 'tool_use', 'refusal', 'unexpected'])('rejects Anthropic stop reason %s', async (stopReason) => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ content: [{ type: 'text', text: 'partial' }], stop_reason: stopReason }));
    await expect(createProvider(connection('anthropic'), { fetch: fetcher }).complete(request()))
      .rejects.toMatchObject({ status: stopReason === 'max_tokens' ? 'incomplete' : 'error' });
  });

  it('redacts reflected credentials in valid completion text and thrown network errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion(`before ${key} after`)));
    expect(await createProvider(connection(), { fetch: fetcher }).complete(request())).toBe('before [redacted] after');
    const failing = vi.fn<typeof fetch>(async () => { throw new Error(`request failed with ${key}`); });
    const result = await createProvider(connection(), { fetch: failing }).complete(request()).catch((error: ProviderError) => error);
    expect((result as ProviderError).message).not.toContain(key);
    expect(failing).toHaveBeenCalledOnce();
  });
});

describe('OpenAI streams', () => {
  it('accepts arbitrary byte splits and ignores keepalives, role, usage, reasoning, and future events', async () => {
    const wire = ': ping\r\n\r\n' + packet('') + packet({ type: 'future' }, 'future_event') +
      packet({ choices: [{ index: 0, delta: { role: 'assistant' } }] }) +
      packet({ choices: [{ index: 0, delta: { reasoning_content: 'not visible' } }] }) +
      packet(delta('<html>caf\u00e9 \ud83d\ude80</html>')) + packet(finish()) +
      packet({ choices: [], usage: { total_tokens: 12 } }) + packet('[DONE]');
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire, 1));
    expect(await collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).toBe('<html>caf\u00e9 \ud83d\ude80</html>');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts [DONE] with streamed content even when no finish_reason is sent', async () => {
    const wire = packet(delta('<html>complete</html>')) + packet('[DONE]');
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire));
    expect(await collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).toBe('<html>complete</html>');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('still rejects [DONE] before finish_reason when no content was streamed', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(packet({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }) + packet('[DONE]')));
    await expect(collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).rejects.toMatchObject({ status: 'incomplete' });
  });

  it('redacts keys across every text-delta boundary without losing unrelated suffixes', async () => {
    for (let split = 1; split < key.length; split++) {
      const wire = packet(delta(`before ${key.slice(0, split)}`)) + packet(delta(`${key.slice(split)} after sk-t`)) + packet(finish()) + packet('[DONE]');
      const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire));
      expect(await collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).toBe('before [redacted] after sk-t');
    }
  });

  it.each([
    ['ababab', ['zababa', 'babx'], 'z[redacted]abx'],
    ['aaaa', ['aaaaa', 'aaaaa'], '[redacted][redacted]aa'],
    ['[redacted]', ['[red', 'acted]'], '***'],
  ])('handles overlapping prefixes and safe replacement markers for %s', async (credential, chunks, expected) => {
    const saved = connection();
    saved.key = credential;
    const wire = chunks.map((text) => packet(delta(text))).join('') + packet(finish()) + packet('[DONE]');
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire));
    const output = await collect(createProvider(saved, { fetch: fetcher }).stream(request()));
    expect(output).toBe(expected);
    expect(output).not.toContain(credential);
  });

  it.each([
    ['missing DONE', packet(delta('partial')) + packet(finish()), 'incomplete'],
    ['bare EOF', packet(delta('partial')), 'incomplete'],
    ['length', packet(delta('partial')) + packet(finish('length')) + packet('[DONE]'), 'incomplete'],
    ['filter', packet(delta('partial')) + packet(finish('content_filter')), 'error'],
    ['tools', packet(delta('partial')) + packet(finish('tool_calls')), 'error'],
    ['empty', packet(finish()) + packet('[DONE]'), 'error'],
    ['malformed JSON', packet('{broken'), 'error'],
    ['unknown shape', packet({ unexpected: true }), 'error'],
    ['wrong content type', packet({ choices: [{ delta: { content: [] } }] }), 'error'],
    ['refusal', packet({ choices: [{ delta: { refusal: key } }] }), 'error'],
    ['provider error', packet({ error: { message: key } }), 'error'],
    ['named error', packet(key, 'error'), 'error'],
    ['text after finish', packet(delta('partial')) + packet(finish()) + packet(delta('late')) + packet('[DONE]'), 'error'],
  ])('rejects %s', async (_name, wire, status) => {
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire));
    let output = '';
    let error: unknown;
    try {
      for await (const chunk of createProvider(connection(), { fetch: fetcher }).stream(request())) output += chunk;
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status });
    expect((error as Error).message).not.toContain(key);
    expect(output).not.toContain(key);
    if (wire.startsWith(packet(delta('partial')))) expect(output).toBe('partial');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('Anthropic streams', () => {
  it('includes initial message/block text, joins text deltas, and ignores thinking/signatures', async () => {
    const values = [
      { type: 'ping' }, { type: 'future_event', payload: true },
      { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '<html>' }] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'hidden' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'hidden' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '<body>' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '\u00e9</body></html>' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(values.map((value) => packet(value, value.type)).join(''), 1));
    expect(await collect(createProvider(connection('anthropic'), { fetch: fetcher }).stream(request()))).toBe('<html><body>\u00e9</body></html>');
  });

  it.each([
    ['missing stop', anthropicPackets().replace(packet({ type: 'message_stop' }, 'message_stop'), ''), 'incomplete'],
    ['truncation', anthropicPackets('partial', 'max_tokens'), 'incomplete'],
    ['tools', anthropicPackets('partial', 'tool_use'), 'error'],
    ['refusal', anthropicPackets('partial', 'refusal'), 'error'],
    ['empty', anthropicPackets(''), 'error'],
    ['error event', packet({ type: 'error', error: { message: key } }, 'error'), 'error'],
    ['missing start', packet({ type: 'message_stop' }, 'message_stop'), 'error'],
    ['missing reason', packet({ type: 'message_start', message: { content: [] } }, 'message_start') + packet({ type: 'message_stop' }, 'message_stop'), 'incomplete'],
    ['unclosed block', anthropicPackets().replace(packet({ type: 'content_block_stop', index: 0 }, 'content_block_stop'), ''), 'error'],
  ])('rejects %s', async (_name, wire, status) => {
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire));
    await expect(collect(createProvider(connection('anthropic'), { fetch: fetcher }).stream(request()))).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('bounds, cancellation, and independent timeouts', () => {
  it('bounds nonstreaming response bytes and individual SSE events', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(completion('x'.repeat(LIMITS.totalOutput))));
    await expect(createProvider(connection(), { fetch: fetcher }).complete(request())).rejects.toMatchObject({ status: 'incomplete' });
    const largeEvent = vi.fn<typeof fetch>(async () => sseResponse(openAi('x'.repeat(LIMITS.sseEvent + 1)), 65536));
    await expect(collect(createProvider(connection(), { fetch: largeEvent }).stream(request()))).rejects.toMatchObject({ status: 'incomplete' });
  });

  it('bounds accumulated output even when each event is small enough', async () => {
    const wire = packet(delta('x'.repeat(1024 * 1024))).repeat(9) + packet(finish()) + packet('[DONE]');
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(wire, 65536));
    await expect(collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).rejects.toMatchObject({ status: 'incomplete' });
  });

  it('aborts upstream and releases the reader on iterator return, without waiting for EOF', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode(packet(delta('partial')))), cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const stream = createProvider(connection(), { fetch: fetcher }).stream(request());
    expect((await stream.next()).value).toBe('partial');
    await stream.return(undefined);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('returns on the successful protocol terminal even if the HTTP body stays open', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode(openAi())), cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).toBe('<html>test</html>');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('prevents paid calls on pre-abort and cancels a pending connection promptly', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = createProvider(connection(), { fetch: fetcher });
    abort.abort();
    await expect(client.complete(request(abort.signal))).rejects.toMatchObject({ status: 'cancelled' });
    await expect(collect(client.stream(request(abort.signal)))).rejects.toMatchObject({ status: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = client.complete(request(active.signal));
    active.abort(new Error(key));
    await expect(pending).rejects.toMatchObject({ status: 'cancelled', message: 'The request was cancelled.' });
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('cancels a blocked stream read and never reports its partial text complete', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode(packet(delta('partial')))), cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const stream = createProvider(connection(), { fetch: fetcher }).stream(request(abort.signal));
    expect((await stream.next()).value).toBe('partial');
    const pending = stream.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ status: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('connect timeout is independent of inactivity and cleans up a late fetch response', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const promise = createProvider(connection(), { fetch: fetcher, connectTimeoutMs: 50, inactivityTimeoutMs: 10 }).complete(request());
    let settled = false;
    void promise.catch(() => { settled = true; });
    const checked = expect(promise).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('connection timeout') });
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    await checked;
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('clears the connection timer after headers and applies inactivity to the next read', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode(packet(delta('partial')))), cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const stream = createProvider(connection(), { fetch: fetcher, connectTimeoutMs: 10, inactivityTimeoutMs: 50 }).stream(request());
    expect((await stream.next()).value).toBe('partial');
    let settled = false;
    const pending = stream.next();
    void pending.catch(() => { settled = true; });
    const checked = expect(pending).rejects.toMatchObject({ status: 'incomplete', message: expect.stringContaining('stalled') });
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('times out nonstreaming body reads without returning a partial JSON result', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }));
    const checked = expect(createProvider(connection(), { fetch: fetcher, inactivityTimeoutMs: 10 }).complete(request()))
      .rejects.toMatchObject({ status: 'incomplete', message: expect.stringContaining('stalled') });
    await vi.advanceTimersByTimeAsync(11);
    await checked;
  });

  it('gives streaming its own header budget instead of the nonstreaming connect budget', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const stream = createProvider(connection(), {
      fetch: fetcher,
      connectTimeoutMs: 10,
      streamHeadersTimeoutMs: 100,
      inactivityTimeoutMs: 500,
    }).stream(request());
    const pending = stream.next();
    let settled = false;
    void pending.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(false);
    const checked = expect(pending).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('connection timeout') });
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    resolve(new Response(new ReadableStream({ cancel() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    await Promise.resolve();
  });

  it('uses the saved first-byte timeout for nonstreaming connects when no option overrides it', async () => {
    vi.useFakeTimers();
    const saved = connection();
    saved.settings.firstByteTimeoutMs = 50;
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const promise = createProvider(saved, { fetch: fetcher }).complete(request());
    let settled = false;
    void promise.catch(() => { settled = true; });
    const checked = expect(promise).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('connection timeout') });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(41);
    await checked;
    resolve(new Response(new ReadableStream({ cancel() {} }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
  });

  it('uses the saved first-byte timeout for streaming headers when no option overrides it', async () => {
    vi.useFakeTimers();
    const saved = connection();
    saved.settings.firstByteTimeoutMs = 50;
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const stream = createProvider(saved, { fetch: fetcher }).stream(request());
    const pending = stream.next();
    let settled = false;
    void pending.catch(() => { settled = true; });
    const checked = expect(pending).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('connection timeout') });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(41);
    await checked;
    resolve(new Response(new ReadableStream({ cancel() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    await Promise.resolve();
  });

  it('uses the saved inactivity timeout between reads when no option overrides it', async () => {
    vi.useFakeTimers();
    const saved = connection();
    saved.settings.inactivityTimeoutMs = 50;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode(packet(delta('partial')))), cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const stream = createProvider(saved, { fetch: fetcher }).stream(request());
    expect((await stream.next()).value).toBe('partial');
    const pending = stream.next();
    const checked = expect(pending).rejects.toMatchObject({ status: 'incomplete', message: expect.stringContaining('stalled') });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(41);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('lets explicit options override saved timeouts', async () => {
    vi.useFakeTimers();
    const saved = connection();
    saved.settings.firstByteTimeoutMs = 1_000_000;
    saved.settings.inactivityTimeoutMs = 1_000_000;
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const promise = createProvider(saved, { fetch: fetcher, connectTimeoutMs: 10, inactivityTimeoutMs: 10 }).complete(request());
    let settled = false;
    void promise.catch(() => { settled = true; });
    const checked = expect(promise).rejects.toMatchObject({ status: 'error', message: expect.stringContaining('connection timeout') });
    await vi.advanceTimersByTimeAsync(11);
    await checked;
    resolve(new Response(new ReadableStream({ cancel() {} }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
  });

  it('ignores reasoning_content deltas and streams the final content', async () => {
    const payload =
      packet({ choices: [{ index: 0, delta: { role: 'assistant' } }] }) +
      packet({ choices: [{ index: 0, delta: { reasoning_content: 'chain of thought' } }] }) +
      packet({ choices: [{ index: 0, delta: { reasoning_content: 'more thought' } }] }) +
      openAi('<html>ok</html>');
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(payload));
    expect(await collect(createProvider(connection(), { fetch: fetcher }).stream(request()))).toBe('<html>ok</html>');
  });

  it('reports a stream that errors after reasoning as incomplete rather than a connection failure', async () => {
    const payload =
      packet({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }) +
      packet({ error: { message: 'upstream boom' } });
    const fetcher = vi.fn<typeof fetch>(async () => sseResponse(payload));
    const error = await collect(createProvider(connection(), { fetch: fetcher }).stream(request())).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 'incomplete' });
    expect((error as Error).message).toContain('reasoning');
  });
});
