import { resolveRequestUrl } from '../shared/connection.js';
import { log, registerSecret } from '../shared/diagnostics.js';
import { readSse, readUtf8, StreamError } from '../shared/stream.js';
import { LIMITS } from '../shared/types.js';
import type { SavedConnection } from './connection.js';

export interface CompletionRequest {
  system: string;
  user: string;
  signal: AbortSignal;
  maxTokens?: number;
  /** Development-only hook that receives the raw request body and provider output. */
  trace?: ProviderTrace;
}

/**
 * Raw, unredacted provider text. Redaction, clipping, and phase labelling happen
 * one layer up so this module never has to know about the inspector.
 */
export interface ProviderTraceEntry {
  dir: 'in' | 'out';
  channel: 'request' | 'response' | 'frame';
  text: string;
}

export type ProviderTrace = (entry: ProviderTraceEntry) => void;

/** Tracing is diagnostic only: a fault in the sink must never fail a paid request. */
function traceSafe(trace: ProviderTrace | undefined, entry: ProviderTraceEntry): void {
  if (!trace) return;
  try {
    trace(entry);
  } catch {
    // Ignored on purpose.
  }
}

export interface ProviderClient {
  complete(request: CompletionRequest): Promise<string>;
  stream(request: CompletionRequest): AsyncGenerator<string>;
}

export class ProviderError extends Error {
  constructor(readonly status: 'error' | 'incomplete' | 'cancelled', message = 'The provider request failed.') {
    super(message);
    this.name = 'ProviderError';
  }
}

const malformed = () => new ProviderError('error', 'The provider returned malformed response data.');
const unsupported = () => new ProviderError('error', 'The provider returned an unsupported response shape. Use a text-capable Chat Completions or Messages model.');
const refused = () => new ProviderError('error', 'The provider refused or filtered this request.');
const cancelled = () => new ProviderError('cancelled', 'The request was cancelled.');
const truncated = () => new ProviderError('incomplete', 'The provider reached its output or context limit before finishing.');
const empty = () => new ProviderError('error', 'The provider returned no usable text.');
const providerFailure = () => new ProviderError('error', 'The provider reported an error. Check the saved connection, model access, and provider limits.');
// A reasoning model streams chain-of-thought on a separate field before any answer.
// Losing the connection or hitting a provider error after reasoning-but-before-answer
// is reported as an incomplete generation, not as a connection or access failure.
const reasoningOnly = () => new ProviderError('incomplete', 'The model streamed reasoning but no final answer before the stream ended. The request may exceed the provider time or output limits.');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

// Structural summary only. Never include string values: a provider may echo the
// credential, and this output is written to a terminal or log file.
function shape(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).slice(0, 24)) {
    const item = (value as Record<string, unknown>)[key];
    out[key] = item === null ? null : Array.isArray(item) ? `array(${item.length})` : typeof item;
  }
  return out;
}

function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed();
  }
  const result = object(value);
  if (result.error != null || result.type === 'error') throw providerFailure();
  return result;
}

function checkFinish(reason: unknown, protocol: 'openai' | 'anthropic'): void {
  if ((protocol === 'openai' && reason === 'stop') ||
    (protocol === 'anthropic' && (reason === 'end_turn' || reason === 'stop_sequence'))) return;
  if (reason === 'length' || reason === 'max_tokens' || reason === 'model_context_window_exceeded' || reason === 'pause_turn') {
    throw truncated();
  }
  if (reason === 'content_filter' || reason === 'refusal') throw refused();
  throw unsupported();
}

function openAiText(value: Record<string, unknown>): string {
  if (value.refusal != null && value.refusal !== '') throw refused();
  if ((value.tool_calls != null && (!Array.isArray(value.tool_calls) || value.tool_calls.length > 0)) ||
    value.function_call != null || value.audio != null) throw unsupported();
  // Reasoning fields (reasoning_content / reasoning) are chain-of-thought, never page
  // output: they are deliberately not returned here. Their presence is tracked by the
  // stream parser so a reasoning-only generation reports as incomplete, not as an error.
  if (value.content == null) return '';
  if (typeof value.content !== 'string') throw unsupported();
  return value.content;
}

function anthropicText(value: unknown): string {
  const block = object(value);
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return '';
  if (block.type === 'refusal') throw refused();
  if (block.type !== 'text') throw unsupported();
  if (typeof block.text !== 'string') throw malformed();
  return block.text;
}

function completionText(value: Record<string, unknown>, protocol: 'openai' | 'anthropic'): string {
  if (protocol === 'openai') {
    if (!Array.isArray(value.choices) || value.choices.length !== 1) throw unsupported();
    const choice = object(value.choices[0]);
    if (choice.index != null && choice.index !== 0) throw unsupported();
    checkFinish(choice.finish_reason, protocol);
    const message = object(choice.message);
    if (message.role != null && message.role !== 'assistant') throw unsupported();
    return openAiText(message);
  }
  checkFinish(value.stop_reason, protocol);
  if (!Array.isArray(value.content) || (value.role != null && value.role !== 'assistant')) throw unsupported();
  return value.content.map(anthropicText).join('');
}

type SseEvent = { event?: string; data: string };

// Coalesce raw upstream frames so one provider response does not double the SSE
// stream frame-for-frame. Each flush is well under the per-event SSE limit.
const TRACE_FLUSH_CHARS = 8 * 1024;

async function* traceFrames(events: AsyncIterable<SseEvent>, trace: ProviderTrace): AsyncGenerator<SseEvent> {
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    traceSafe(trace, { dir: 'out', channel: 'frame', text: buffer });
    buffer = '';
  };
  try {
    for await (const event of events) {
      buffer += (buffer ? '\n' : '') + (event.event ? `event: ${event.event}\n` : '') + `data: ${event.data}`;
      if (buffer.length >= TRACE_FLUSH_CHARS) flush();
      yield event;
    }
  } finally {
    // The protocol parser returns as soon as it sees its terminal marker, so the
    // remaining frames are only guaranteed to flush here.
    flush();
  }
}

async function* openAiStream(events: AsyncIterable<SseEvent>): AsyncGenerator<string> {
  let finished = false;
  let reasoned = false;
  let received = false;
  for await (const event of events) {
    if (event.event === 'error') {
      log.server('warn', 'provider', 'openai: named error event', { event: event.event, reasoned });
      if (reasoned) throw reasoningOnly();
      throw providerFailure();
    }
    if (!event.data.trim() || event.event === 'ping' || event.event === 'keepalive') continue;
    if (event.data.trim() === '[DONE]') {
      if (!finished) {
        // Some OpenAI-compatible gateways terminate with [DONE] but never send a
        // finish_reason. When real content was streamed, accept the response: the
        // content is complete and the missing reason is a provider quirk, not a
        // truncation. Only a content-free stream is a genuine failure.
        if (received) {
          log.server('warn', 'provider', 'openai: [DONE] before any finish_reason; accepting streamed content', { reasoned });
          return;
        }
        log.server('warn', 'provider', 'openai: [DONE] before any finish_reason', { reasoned });
        if (reasoned) throw reasoningOnly();
        throw new ProviderError('incomplete', 'The provider ended the stream without a successful finish reason.');
      }
      log.server('debug', 'provider', 'openai: [DONE] received');
      return;
    }
    let packet: Record<string, unknown>;
    try {
      packet = parseJson(event.data);
    } catch (error) {
      if (reasoned && error instanceof ProviderError && error.status === 'error') {
        log.server('warn', 'provider', 'openai: provider error after reasoning but before content');
        throw reasoningOnly();
      }
      throw error;
    }
    if (packet.type === 'ping') continue;
    if (!Array.isArray(packet.choices)) {
      if (packet.usage != null || (event.event && event.event !== 'message')) continue;
      log.server('warn', 'provider', 'openai: packet without choices', { shape: shape(packet), event: event.event });
      throw unsupported();
    }
    if (packet.choices.length === 0) continue;
    if (packet.choices.length !== 1) {
      log.server('warn', 'provider', 'openai: unexpected choice count', { choices: packet.choices.length });
      throw unsupported();
    }
    const choice = object(packet.choices[0]);
    if (choice.index != null && choice.index !== 0) throw unsupported();
    const delta = object(choice.delta);
    if (delta.role != null && delta.role !== 'assistant') throw unsupported();
    if (delta.reasoning_content != null || delta.reasoning != null) reasoned = true;
    const text = openAiText(delta);
    if (finished && (text || choice.finish_reason != null)) {
      log.server('warn', 'provider', 'openai: data after finish_reason', { hasText: !!text });
      throw malformed();
    }
    if (text) {
      received = true;
      yield text;
    }
    if (choice.finish_reason != null) {
      log.server('info', 'provider', 'openai: finish_reason', { reason: choice.finish_reason });
      checkFinish(choice.finish_reason, 'openai');
      finished = true;
    }
  }
  log.server('warn', 'provider', 'openai: stream ended without [DONE]', { finished, reasoned });
  if (reasoned) throw reasoningOnly();
  throw new ProviderError('incomplete', 'The provider disconnected before the [DONE] marker.');
}

async function* anthropicStream(events: AsyncIterable<SseEvent>): AsyncGenerator<string> {
  let started = false;
  let finished = false;
  const active = new Map<number, string>();
  const seen = new Set<number>();
  for await (const event of events) {
    if (event.event === 'error') {
      log.server('warn', 'provider', 'anthropic: named error event', { event: event.event });
      throw providerFailure();
    }
    if (!event.data.trim()) continue;
    const packet = parseJson(event.data);
    const type = packet.type;
    if (type === 'ping') continue;
    if (typeof type !== 'string') {
      log.server('warn', 'provider', 'anthropic: packet without a type', { shape: shape(packet) });
      throw unsupported();
    }
    if (!['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type)) {
      log.server('debug', 'provider', 'anthropic: ignored event type', { type });
      continue;
    }
    if (event.event && event.event !== type) {
      log.server('warn', 'provider', 'anthropic: event name does not match packet type', { event: event.event, type });
      throw malformed();
    }
    if (type === 'message_start') {
      if (started) throw malformed();
      const message = object(packet.message);
      if (!Array.isArray(message.content) || (message.role != null && message.role !== 'assistant') || message.stop_reason != null) {
        log.server('warn', 'provider', 'anthropic: unsupported message_start', { shape: shape(packet.message) });
        throw unsupported();
      }
      started = true;
      log.server('debug', 'provider', 'anthropic: message_start', { blocks: message.content.length });
      for (const block of message.content) {
        const text = anthropicText(block);
        if (text) yield text;
      }
      continue;
    }
    if (!started) {
      log.server('warn', 'provider', 'anthropic: event before message_start', { type });
      throw malformed();
    }
    if (type === 'message_stop') {
      if (!finished || active.size) {
        log.server('warn', 'provider', 'anthropic: message_stop before a clean finish', { finished, openBlocks: active.size });
        throw new ProviderError('incomplete', 'The provider stopped before all text blocks finished successfully.');
      }
      log.server('debug', 'provider', 'anthropic: message_stop received');
      return;
    }
    if (type === 'message_delta') {
      const delta = object(packet.delta);
      if (delta.stop_reason != null) {
        log.server('info', 'provider', 'anthropic: stop_reason', { reason: delta.stop_reason, openBlocks: active.size });
        checkFinish(delta.stop_reason, 'anthropic');
        if (finished || active.size) throw malformed();
        finished = true;
      }
      continue;
    }
    if (finished) throw malformed();
    const index = packet.index;
    if (!Number.isSafeInteger(index) || (index as number) < 0) throw malformed();
    const blockIndex = index as number;
    if (type === 'content_block_start') {
      if (seen.has(blockIndex) || seen.size >= 1024) throw malformed();
      const block = object(packet.content_block);
      const text = anthropicText(block);
      seen.add(blockIndex);
      active.set(blockIndex, block.type as string);
      if (text) yield text;
    } else if (type === 'content_block_stop') {
      if (!active.delete(blockIndex)) throw malformed();
    } else {
      const blockType = active.get(blockIndex);
      if (!blockType) throw malformed();
      const delta = object(packet.delta);
      if (blockType === 'text' && delta.type === 'text_delta') {
        if (typeof delta.text !== 'string') throw malformed();
        if (delta.text) yield delta.text;
      } else if ((blockType === 'thinking' || blockType === 'redacted_thinking') &&
        (delta.type === 'thinking_delta' || delta.type === 'signature_delta')) {
        continue;
      } else {
        log.server('warn', 'provider', 'anthropic: unsupported content block delta', { blockType, delta: shape(packet.delta) });
        throw unsupported();
      }
    }
  }
  log.server('warn', 'provider', 'anthropic: stream ended without message_stop', { started, finished, openBlocks: active.size });
  throw new ProviderError('incomplete', 'The provider disconnected before the message_stop event.');
}

// Retain only the suffix that could become a credential in the next text delta.
// KMP prefix matching keeps even long, repetitive keys linear to scan.
function redactor(key: string): { push(text: string): string; finish(): string } {
  const prefix = new Uint32Array(key.length);
  for (let index = 1, matched = 0; index < key.length; index++) {
    while (matched && key[index] !== key[matched]) matched = prefix[matched - 1];
    if (key[index] === key[matched]) matched++;
    prefix[index] = matched;
  }
  const marker = !key.includes('[') && !key.includes(']') && !'[redacted]'.includes(key)
    ? '[redacted]'
    : (['*', '#', '\ufffd'].find((char) => !key.includes(char)) ?? '\u0000').repeat(3);
  let tail = '';
  return {
    push(text) {
      const clean = (tail + text).replaceAll(key, marker);
      let matched = 0;
      for (let index = Math.max(0, clean.length - key.length + 1); index < clean.length; index++) {
        while (matched && clean[index] !== key[matched]) matched = prefix[matched - 1];
        if (clean[index] === key[matched]) matched++;
      }
      tail = clean.slice(clean.length - matched);
      return clean.slice(0, clean.length - matched);
    },
    finish() {
      const rest = tail;
      tail = '';
      return rest;
    },
  };
}

function normalized(error: unknown, signal: AbortSignal, streaming: boolean): ProviderError {
  if (signal.aborted) return cancelled();
  if (error instanceof ProviderError) return error;
  if (error instanceof StreamError) {
    if (error.code === 'cancelled') return cancelled();
    return new ProviderError(error.code === 'utf8' ? 'error' : 'incomplete', error.message);
  }
  return new ProviderError(streaming ? 'incomplete' : 'error', 'The provider connection failed or was interrupted.');
}

export function createProvider(
  connection: SavedConnection,
  options: { fetch?: typeof globalThis.fetch; connectTimeoutMs?: number; streamHeadersTimeoutMs?: number; inactivityTimeoutMs?: number } = {},
): ProviderClient {
  const settings = {
    ...connection.settings,
    openaiTokenLimit: connection.settings.openaiTokenLimit ? { ...connection.settings.openaiTokenLimit } : undefined,
  };
  const key = connection.key;
  if (!key || key.length > 16384) throw new ProviderError('error', 'The saved provider credential is invalid.');
  let url: string;
  try {
    url = resolveRequestUrl(settings.protocol, settings.apiUrl);
  } catch {
    throw new ProviderError('error', 'The saved provider URL is invalid.');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const connectMs = options.connectTimeoutMs ?? settings.firstByteTimeoutMs ?? LIMITS.connectMs;
  // Streamed responses only send headers once the provider has its first token, so
  // a streaming request gets its own, longer time-to-header budget. An explicit
  // connectTimeoutMs still overrides it so injected test/embedding timeouts behave.
  // Saved per-connection timeouts sit between injected options and the built-in defaults.
  const streamHeadersMs = options.streamHeadersTimeoutMs ?? options.connectTimeoutMs ?? settings.firstByteTimeoutMs ?? LIMITS.streamHeadersMs;
  const inactivityMs = options.inactivityTimeoutMs ?? settings.inactivityTimeoutMs ?? LIMITS.inactivityMs;
  if (![connectMs, streamHeadersMs, inactivityMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new ProviderError('error', 'Provider timeouts must be positive integers.');
  }
  registerSecret(key);
  log.server('info', 'provider', 'client created', {
    protocol: settings.protocol,
    model: settings.model,
    url,
    anthropicMaxTokens: settings.anthropicMaxTokens,
    openaiTokenLimit: settings.openaiTokenLimit,
    connectMs,
    streamHeadersMs,
    inactivityMs,
  });

  async function open(request: CompletionRequest, streaming: boolean) {
    if (request.signal.aborted) {
      log.server('warn', 'provider', 'refused: signal already aborted before the paid call', { streaming });
      throw cancelled();
    }
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) {
      throw new ProviderError('error', 'The request token limit is invalid.');
    }
    const body: Record<string, unknown> = { model: settings.model, stream: streaming };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
    };
    if (settings.protocol === 'openai') {
      headers.authorization = `Bearer ${key}`;
      body.messages = [{ role: 'system', content: request.system }, { role: 'user', content: request.user }];
      if (settings.openaiTokenLimit) {
        body[settings.openaiTokenLimit.field] = Math.min(settings.openaiTokenLimit.value, request.maxTokens ?? settings.openaiTokenLimit.value);
      }
    } else {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      body.system = request.system;
      body.messages = [{ role: 'user', content: request.user }];
      body.max_tokens = Math.min(settings.anthropicMaxTokens ?? 8192, request.maxTokens ?? Infinity);
    }
    const json = JSON.stringify(body);
    if (new TextEncoder().encode(json).byteLength > LIMITS.requestBytes) {
      throw new ProviderError('error', 'The provider request exceeded the safe size limit.');
    }
    traceSafe(request.trace, { dir: 'in', channel: 'request', text: json });
    // streaming waits for the first upstream token, non-streaming for the whole answer.
    const headerTimeoutMs = streaming ? streamHeadersMs : connectMs;
    log.server('info', 'provider', `open ${settings.protocol} ${streaming ? 'stream' : 'complete'}`, {
      url,
      model: settings.model,
      maxTokens: request.maxTokens,
      bodyBytes: new TextEncoder().encode(json).byteLength,
      headerTimeoutMs,
      inactivityMs,
    });
    const controller = new AbortController();
    let response: Response | undefined;
    let closed = false;
    let rejectInterrupt!: (error: ProviderError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupt = reject; });
    void interrupted.catch(() => {});
    const abort = () => {
      log.server('warn', 'provider', 'upstream abort requested by caller', { streaming });
      controller.abort();
      rejectInterrupt(cancelled());
    };
    const close = () => {
      closed = true;
      request.signal.removeEventListener('abort', abort);
      controller.abort();
      if (response?.body) void response.body.cancel().catch(() => {});
    };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => {
      log.server('warn', 'provider', 'connect timeout before headers', { headerTimeoutMs, streaming });
      rejectInterrupt(new ProviderError('error', 'The provider did not respond before the connection timeout.'));
      controller.abort();
    }, headerTimeoutMs);
    try {
      if (request.signal.aborted) throw cancelled();
      const pending = fetcher(url, { method: 'POST', headers, body: json, signal: controller.signal, redirect: 'manual' });
      void pending.then((late) => {
        if (closed && late.body) void late.body.cancel().catch(() => {});
      }, () => {});
      response = await Promise.race([pending, interrupted]);
      clearTimeout(timer);
      if (request.signal.aborted) throw cancelled();
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      log.server('info', 'provider', 'response headers received', {
        streaming,
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        contentType,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new ProviderError('error', 'Provider redirects are not allowed. Use the final API URL.');
      }
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'The provider rejected the credentials or access to this model.'
          : response.status === 429
            ? 'The provider rate limit or quota was reached.'
            : 'The provider returned an HTTP error. Check the provider service and connection settings.';
        log.server('error', 'provider', 'provider returned an HTTP error', { status: response.status });
        throw new ProviderError('error', message);
      }
      if (streaming ? contentType !== 'text/event-stream' : !contentType || !/^application\/(?:[\w.+-]+\+)?json$/.test(contentType)) {
        log.server('error', 'provider', 'unexpected content type', { streaming, contentType });
        throw new ProviderError('error', 'The provider returned an unexpected content type. Check the protocol and API URL.');
      }
      if (!response.body) {
        log.server('error', 'provider', 'response had no body');
        throw empty();
      }
      return { response, signal: controller.signal, close };
    } catch (error) {
      log.server('warn', 'provider', 'open failed', { streaming, error, signalAborted: request.signal.aborted });
      close();
      throw normalized(error, request.signal, false);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete(request) {
      let exchange: Awaited<ReturnType<typeof open>> | undefined;
      try {
        exchange = await open(request, false);
        let json = '';
        for await (const text of readUtf8(exchange.response.body!, exchange.signal, {
          maxBytes: LIMITS.totalOutput,
          inactivityTimeoutMs: inactivityMs,
          label: `provider:${settings.protocol}:complete`,
        })) json += text;
        traceSafe(request.trace, { dir: 'out', channel: 'response', text: json });
        const text = completionText(parseJson(json), settings.protocol);
        log.server('info', 'provider', 'completion parsed', { protocol: settings.protocol, bodyChars: json.length, textChars: text.length });
        if (!text.trim()) throw empty();
        if (text.length > LIMITS.totalOutput) throw truncated();
        if (request.signal.aborted) throw cancelled();
        const redact = redactor(key);
        const clean = redact.push(text) + redact.finish();
        if (clean.length > LIMITS.totalOutput) throw truncated();
        return clean;
      } catch (error) {
        log.server('warn', 'provider', 'completion failed', { protocol: settings.protocol, error, signalAborted: request.signal.aborted });
        throw normalized(error, request.signal, false);
      } finally {
        exchange?.close();
      }
    },
    async *stream(request) {
      let exchange: Awaited<ReturnType<typeof open>> | undefined;
      try {
        exchange = await open(request, true);
        const events = readSse(exchange.response.body!, exchange.signal, {
          inactivityTimeoutMs: inactivityMs,
          label: `provider:${settings.protocol}:stream`,
        });
        const tapped = request.trace ? traceFrames(events, request.trace) : events;
        const source = settings.protocol === 'openai' ? openAiStream(tapped) : anthropicStream(tapped);
        const redact = redactor(key);
        let total = 0;
        let cleanTotal = 0;
        let hasText = false;
        let deltas = 0;
        for await (const text of source) {
          if (request.signal.aborted) throw cancelled();
          total += text.length;
          deltas++;
          if (total > LIMITS.totalOutput) throw truncated();
          hasText ||= /\S/.test(text);
          const clean = redact.push(text);
          cleanTotal += clean.length;
          if (cleanTotal > LIMITS.totalOutput) throw truncated();
          if (clean) yield clean;
        }
        if (request.signal.aborted) throw cancelled();
        log.server('info', 'provider', 'stream finished', { protocol: settings.protocol, deltas, textChars: total, hasText });
        if (!hasText) throw empty();
        const tail = redact.finish();
        if (cleanTotal + tail.length > LIMITS.totalOutput) throw truncated();
        if (tail) yield tail;
        if (request.signal.aborted) throw cancelled();
      } catch (error) {
        const detail = normalized(error, request.signal, true);
        log.server('warn', 'provider', 'stream failed', { protocol: settings.protocol, error, normalized: detail, signalAborted: request.signal.aborted });
        throw detail;
      } finally {
        exchange?.close();
      }
    },
  };
}
