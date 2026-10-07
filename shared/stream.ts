import { createParser } from 'eventsource-parser';
import { log } from './diagnostics.js';
import { LIMITS } from './types.js';

export class StreamError extends Error {
  constructor(readonly code: 'limit' | 'utf8' | 'timeout' | 'cancelled' | 'disconnected') {
    super({
      limit: 'The response exceeded the safe size limit.',
      utf8: 'The response contained invalid UTF-8.',
      timeout: 'The response stalled before it finished.',
      cancelled: 'The request was cancelled.',
      disconnected: 'The response was interrupted.',
    }[code]);
    this.name = 'StreamError';
  }
}

export interface StreamOptions {
  maxBytes?: number;
  maxEventChars?: number;
  inactivityTimeoutMs?: number;
  /** Human-readable stream identity used only in diagnostics. */
  label?: string;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Stream limits must be positive integers.');
  return value;
}

// Decode small slices, not an arbitrarily large upstream chunk. TextDecoder retains
// at most the unfinished UTF-8 code point between slices.
export async function* readUtf8(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: StreamOptions = {},
): AsyncGenerator<string> {
  const maxBytes = positive(options.maxBytes ?? LIMITS.totalOutput * 8);
  const inactivityMs = positive(options.inactivityTimeoutMs ?? LIMITS.inactivityMs);
  const label = options.label ?? 'stream';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let chunks = 0;
  let failure: StreamError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  log.debug('stream', `${label}: reading UTF-8 body`, { maxBytes, inactivityMs });
  let interrupt!: (error: StreamError) => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = (error) => {
      if (failure) return;
      failure = error;
      log.warn('stream', `${label}: interrupted`, { code: error.code, totalBytes: total });
      void reader.cancel().catch(() => {});
      reject(error);
    };
  });
  // An abort may arrive while the consumer is processing a yielded chunk.
  void interrupted.catch(() => {});
  const abort = () => interrupt(new StreamError('cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    while (true) {
      if (failure) throw failure;
      timer = setTimeout(() => interrupt(new StreamError('timeout')), inactivityMs);
      const result = await Promise.race([reader.read(), interrupted]);
      clearTimeout(timer);
      timer = undefined;
      if (failure) throw failure;
      if (result.done) break;
      chunks++;
      total += result.value.byteLength;
      if (total > maxBytes) throw new StreamError('limit');
      for (let offset = 0; offset < result.value.byteLength; offset += 16384) {
        if (failure) throw failure;
        let text: string;
        try {
          text = decoder.decode(result.value.subarray(offset, offset + 16384), { stream: true });
        } catch {
          throw new StreamError('utf8');
        }
        if (text) yield text;
      }
    }
    let tail: string;
    try {
      tail = decoder.decode();
    } catch {
      throw new StreamError('utf8');
    }
    if (tail) yield tail;
    if (failure) throw failure;
  } catch (error) {
    const normalized = failure ?? (error instanceof StreamError ? error : new StreamError('disconnected'));
    log.warn('stream', `${label}: body read failed`, { code: normalized.code, totalBytes: total, chunks, signalAborted: signal?.aborted ?? false });
    throw normalized;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Do not let a broken source's cancellation promise hold cleanup open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    log.info('stream', `${label}: body reader closed`, { totalBytes: total, chunks, endedBy: failure?.code ?? 'eof', signalAborted: signal?.aborted ?? false });
  }
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: StreamOptions = {},
): AsyncGenerator<{ event?: string; data: string }> {
  const maxEvent = positive(options.maxEventChars ?? LIMITS.sseEvent);
  const label = options.label ?? 'sse';
  const events: { event?: string; data: string }[] = [];
  let failure: StreamError | undefined;
  let frames = 0;
  let trailingCr = false;
  const parser = createParser({
    maxBufferSize: maxEvent,
    onEvent: ({ event, data, id }) => {
      // The parser's buffer limit also needs this check for a complete event
      // delivered in a single feed (which never enters its partial buffer).
      if (data.length + (event?.length ?? 0) + (id?.length ?? 0) > maxEvent) {
        failure = new StreamError('limit');
      } else if (!failure) {
        events.push({ event, data });
      }
    },
    onError: (error) => {
      if (error.type === 'max-buffer-size-exceeded') {
        log.warn('sse', `${label}: event exceeded the parser buffer`, { maxEvent });
        failure = new StreamError('limit');
      }
      // Unknown fields and invalid retry hints are ignored by the SSE standard.
    },
  });
  try {
    for await (const text of readUtf8(body, signal, options)) {
      trailingCr = text.endsWith('\r');
      parser.feed(text);
      for (const event of events) {
        if (signal?.aborted) throw new StreamError('cancelled');
        frames++;
        yield event;
      }
      events.length = 0;
      if (failure) throw failure;
    }
    // A final bare CR is a line ending, not a reason to synthesize a missing
    // blank line. Other unfinished events are deliberately discarded at EOF.
    if (trailingCr) parser.feed('\n');
    for (const event of events) {
      if (signal?.aborted) throw new StreamError('cancelled');
      frames++;
      yield event;
    }
    if (failure) throw failure;
  } catch (error) {
    if (error instanceof StreamError && error.code !== 'cancelled') {
      log.warn('sse', `${label}: SSE parse failed`, { code: error.code, frames });
    }
    throw error;
  } finally {
    parser.reset();
    events.length = 0;
    log.info('sse', `${label}: parser closed`, { frames, endedBy: failure?.code ?? 'eof', signalAborted: signal?.aborted ?? false });
  }
}

export function stripOuterFences(text: string): string {
  const match = /^\s*(`{3,}|~{3,})[\w-]*[ \t]*(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)\1[ \t]*\s*$/.exec(text);
  return match ? match[2] : text;
}

export function isHtmlSource(text: string): boolean {
  return /<[a-z][\w:-]*(?:\s|\/?>)/i.test(text);
}

// Extract a self-contained HTML document from surrounding prose, Markdown
// fences, or commentary. Prefers the outermost <!doctype html>…</html> /
// <html…>…</html> span, then falls back to a fenced block, then the input.
export function extractHtml(text: string): string {
  const stripped = stripOuterFences(text);
  const start = stripped.search(/<!doctype\s+html|<html[\s>]/i);
  if (start >= 0) {
    const end = stripped.toLowerCase().lastIndexOf('</html>');
    if (end > start) return stripped.slice(start, end + '</html>'.length);
  }
  const fenced = /(?:^|[\r\n])\s*(`{3,}|~{3,})[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?=[\r\n]|$)/.exec(stripped);
  return fenced ? fenced[2] : stripped;
}

export interface VariationRecord {
  name: string;
  html: string;
}

export class VariationScanError extends Error {
  constructor(readonly status: 'error' | 'incomplete', message: string) {
    super(message);
    this.name = 'VariationScanError';
  }
}

export interface VariationScannerOptions {
  maxBufferChars?: number;
  maxOutputChars?: number;
  maxHtmlChars?: number;
  maxRecords?: number;
}

// Accept whitespace-separated JSON objects, optionally inside one outer fence.
// push() yields before scanning later input, so a later error cannot erase an
// already validated record, even when both arrived in the same network chunk.
export class VariationScanner {
  private readonly maxBuffer: number;
  private readonly maxOutput: number;
  private readonly maxHtml: number;
  private readonly maxRecords: number;
  private total = 0;
  private buffer = '';
  private length = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private fence: string | undefined;
  private fenceLine: string | undefined;
  private closed = false;
  private ended = false;
  private records = 0;

  constructor(options: VariationScannerOptions = {}) {
    this.maxBuffer = positive(options.maxBufferChars ?? LIMITS.variationBuffer);
    this.maxOutput = positive(options.maxOutputChars ?? LIMITS.totalOutput);
    this.maxHtml = positive(options.maxHtmlChars ?? LIMITS.html);
    this.maxRecords = positive(options.maxRecords ?? 3);
  }

  get count(): number {
    return this.records;
  }

  private endFenceLine(): void {
    const line = this.fenceLine!;
    this.fenceLine = undefined;
    if (!this.fence && this.records === 0 && /^(?:```|~~~)(?:json|jsonl|ndjson)?[ \t]*$/i.test(line)) {
      this.fence = line.slice(0, 3);
    } else if (this.fence && line.trimEnd() === this.fence) {
      this.closed = true;
    } else {
      throw new VariationScanError('error', 'The variations contained an invalid Markdown fence.');
    }
  }

  *push(chunk: string): Generator<VariationRecord> {
    if (this.ended) throw new VariationScanError('error', 'The variation stream has already ended.');
    let start = this.depth ? 0 : -1;
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      if (++this.total > this.maxOutput) {
        throw new VariationScanError('incomplete', 'The variations exceeded the safe output limit.');
      }
      if (this.fenceLine !== undefined) {
        if (char === '\r' || char === '\n') this.endFenceLine();
        else {
          this.fenceLine += char;
          if (this.fenceLine.length > Math.min(64, this.maxBuffer)) {
            throw new VariationScanError('error', 'The variations contained an invalid Markdown fence.');
          }
        }
        continue;
      }
      if (!this.depth) {
        if (/\s/.test(char)) continue;
        if (this.closed) throw new VariationScanError('error', 'Unexpected text followed the variations.');
        if ((char === '`' || char === '~') && (this.records === 0 || this.fence)) {
          this.fenceLine = char;
          continue;
        }
        if (char !== '{') throw new VariationScanError('error', 'The provider returned malformed variation JSON.');
        if (this.records >= this.maxRecords) {
          throw new VariationScanError('error', 'The provider returned too many variations.');
        }
        this.depth = 1;
        this.length = 1;
        start = index;
        continue;
      }
      if (++this.length > this.maxBuffer) {
        throw new VariationScanError('incomplete', 'A variation exceeded the safe JSON buffer limit.');
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
      } else if (char === '"') this.quoted = true;
      else if (char === '{') this.depth++;
      else if (char === '}') this.depth--;
      if (this.depth) continue;

      this.buffer += chunk.slice(start, index + 1);
      start = -1;
      let value: unknown;
      try {
        value = JSON.parse(this.buffer);
      } catch {
        throw new VariationScanError('error', 'The provider returned malformed variation JSON.');
      }
      this.buffer = '';
      this.length = 0;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new VariationScanError('error', 'A variation must contain a name and HTML.');
      }
      const record = value as Record<string, unknown>;
      if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(record.name) || typeof record.html !== 'string') {
        throw new VariationScanError('error', 'A variation must contain a short name and HTML.');
      }
      const html = stripOuterFences(record.html);
      if (!html.trim() || !isHtmlSource(html)) {
        throw new VariationScanError('error', 'A variation did not contain usable HTML.');
      }
      if (html.length > this.maxHtml) {
        throw new VariationScanError('incomplete', 'A variation exceeded the safe HTML limit.');
      }
      this.records++;
      yield { name: record.name.trim(), html };
    }
    if (start >= 0) this.buffer += chunk.slice(start);
  }

  finish(): void {
    this.ended = true;
    if (this.depth) throw new VariationScanError('incomplete', 'The final variation was cut off.');
    if (this.fenceLine !== undefined) this.endFenceLine();
    if (this.fence && !this.closed) {
      throw new VariationScanError('incomplete', 'The variation response ended before its closing fence.');
    }
  }
}
