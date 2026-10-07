import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSse, readUtf8, StreamError, extractHtml, stripOuterFences, VariationScanner, VariationScanError } from '../shared/stream.js';
import type { VariationRecord } from '../shared/stream.js';

const encoder = new TextEncoder();

function bytes(parts: Uint8Array[], cancel = vi.fn()): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
    cancel,
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

afterEach(() => vi.useRealTimers());

describe('bounded UTF-8 SSE', () => {
  it('handles every byte split, BOM, Unicode, CRLF, and multiline data', async () => {
    const data = encoder.encode('\ufeff: comment\r\nevent: update\r\ndata: caf\u00e9 \ud83d\ude80\r\ndata: second line\r\n\r\ndata:\r\n\r\n');
    const expected = [{ event: 'update', data: 'caf\u00e9 \ud83d\ude80\nsecond line' }, { event: undefined, data: '' }];
    for (let split = 1; split < data.length; split++) {
      expect(await collect(readSse(bytes([data.slice(0, split), data.slice(split)])))).toEqual(expected);
    }
    expect(await collect(readSse(bytes(Array.from(data, (byte) => Uint8Array.of(byte)))))).toEqual(expected);
  });

  it.each(['\n', '\r\n', '\r'])('accepts %j line endings, including a terminal bare CR', async (ending) => {
    const data = encoder.encode(`data: one${ending}${ending}data: two${ending}${ending}`);
    expect(await collect(readSse(bytes(Array.from(data, (byte) => Uint8Array.of(byte)))))).toEqual([
      { event: undefined, data: 'one' }, { event: undefined, data: 'two' },
    ]);
  });

  it('ignores comments/unknown fields/retry hints but does not invent an EOF event', async () => {
    const data = ': ping\nunknown: ignored\nretry: invalid\nevent: ignored-without-data\n\n' +
      'event: custom\ndata: valid\n\ndata: truncated\n';
    expect(await collect(readSse(bytes([encoder.encode(data)])))).toEqual([{ event: 'custom', data: 'valid' }]);
  });

  it.each([
    'data: ' + 'x'.repeat(65) + '\n\n',
    'data: ' + 'x'.repeat(65),
    'data: ' + 'x'.repeat(35) + '\ndata: ' + 'y'.repeat(35) + '\n',
  ])('bounds complete, partial, and multiline events', async (data) => {
    const body = bytes([encoder.encode(data)]);
    await expect(collect(readSse(body, undefined, { maxEventChars: 64 }))).rejects.toMatchObject({ code: 'limit' });
    expect(body.locked).toBe(false);
  });

  it('bounds wire bytes even when the stream only sends keepalives', async () => {
    await expect(collect(readSse(bytes([encoder.encode(': ping\n'.repeat(20))]), undefined, { maxBytes: 32 })))
      .rejects.toMatchObject({ code: 'limit' });
  });

  it.each([Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xf0, 0x9f)])('rejects invalid or unfinished UTF-8', async (data) => {
    await expect(collect(readUtf8(bytes([data])))).rejects.toMatchObject({ code: 'utf8' });
  });

  it('cancels and unlocks a reader when the consumer returns early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('data: one\n\n')), cancel });
    const stream = readSse(body);
    expect((await stream.next()).value?.data).toBe('one');
    await stream.return(undefined);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('interrupts a pending read on abort without trusting the source cancel promise', async () => {
    const abort = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const stream = readSse(body, abort.signal);
    const next = stream.next();
    abort.abort(new Error('untrusted cancellation reason'));
    await expect(next).rejects.toMatchObject({ code: 'cancelled', message: 'The request was cancelled.' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('handles an already-aborted signal without delivering queued events', async () => {
    const abort = new AbortController();
    abort.abort();
    const body = bytes([encoder.encode('data: late\n\n')]);
    await expect(collect(readSse(body, abort.signal))).rejects.toMatchObject({ code: 'cancelled' });
    expect(body.locked).toBe(false);
  });

  it('measures inactivity while reading, not while the consumer is processing', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('data: first\n\n')), cancel });
    const stream = readSse(body, undefined, { inactivityTimeoutMs: 50 });
    expect((await stream.next()).value?.data).toBe('first');
    await vi.advanceTimersByTimeAsync(500);
    expect(cancel).not.toHaveBeenCalled();
    const pending = expect(stream.next()).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('normalizes source exceptions without reflecting their contents', async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => { throw new Error('secret source details'); } });
    await expect(collect(readSse(body))).rejects.toEqual(new StreamError('disconnected'));
    expect(body.locked).toBe(false);
  });
});

describe('outer fences', () => {
  it('removes only a paired outer fence, leaving embedded backticks and whitespace alone', () => {
    const html = '<html><script>const code = "```";</script></html>';
    expect(stripOuterFences(` \n\`\`\`html\r\n${html}\r\n\`\`\`\n`)).toBe(html);
    expect(stripOuterFences(`~~~json\n["a"]\n~~~`)).toBe('["a"]');
    expect(stripOuterFences(`  ${html}\n`)).toBe(`  ${html}\n`);
    expect(stripOuterFences(`\`\`\`html\n${html}`)).toBe(`\`\`\`html\n${html}`);
    expect(stripOuterFences(`before\n\`\`\`html\n${html}\n\`\`\``)).toContain('before');
  });
});

describe('html extraction', () => {
  it('drops prose before and after a fenced document', () => {
    const html = '<!DOCTYPE html>\n<html lang="en"><head></head><body><p>caf\u00e9</p></body></html>';
    const output = `Here is a fully self-contained HTML document.\n\`\`\`html\n${html}\n\`\`\`\n### Layout\nSome closing notes.`;
    expect(extractHtml(output)).toBe(html);
  });

  it('drops a leading comment and trailing commentary without a fence', () => {
    const html = '<!doctype html><html><body><p>ok</p></body></html>';
    expect(extractHtml(`<!-- UNTRUSTED GENERATED HTML. -->\n${html}\n\nOptimization Tip: edit DUR.`)).toBe(html);
  });

  it('falls back to a fenced block when no document wrapper exists', () => {
    expect(extractHtml('Note:\n```html\n<section>fragment</section>\n```\nDone.')).toBe('<section>fragment</section>');
  });

  it('passes through clean input and unclosed fragments unchanged', () => {
    const html = '<!doctype html><html><body>x</body></html>';
    expect(extractHtml(html)).toBe(html);
    expect(extractHtml('<div>no wrapper</div>')).toBe('<div>no wrapper</div>');
  });
});

describe('incremental variation scanner', () => {
  const record = {
    name: 'Ink Study',
    html: '<html><style>.x{content:"}"}</style><script>const text = "{ \\" ";</script>\n<p>caf\u00e9</p></html>',
  };

  it('understands strings, escaped quotes/newlines/backslashes, and arbitrary character splits', () => {
    const json = JSON.stringify(record);
    for (let split = 1; split < json.length; split++) {
      const scanner = new VariationScanner();
      const results = [...scanner.push(json.slice(0, split)), ...scanner.push(json.slice(split))];
      scanner.finish();
      expect(results).toEqual([record]);
    }
    const scanner = new VariationScanner();
    const results = Array.from(json).flatMap((char) => [...scanner.push(char)]);
    scanner.finish();
    expect(results).toEqual([record]);
  });

  it.each(['```json\r\n', '~~~ndjson\n', ''])('accepts complete objects immediately with optional fences %j', (opening) => {
    const scanner = new VariationScanner();
    const json = [record, { ...record, name: 'Metal' }, { ...record, name: 'Wire' }].map((entry) => JSON.stringify(entry)).join('\n');
    const output = opening + json + (opening ? '\n' + opening.slice(0, 3) : '');
    const results = Array.from(output).flatMap((char) => [...scanner.push(char)]);
    scanner.finish();
    expect(results).toHaveLength(3);
    expect(scanner.count).toBe(3);
  });

  it('retains a valid record preceding malformed JSON in the very same chunk', () => {
    const scanner = new VariationScanner();
    const saved: VariationRecord[] = [];
    expect(() => {
      for (const value of scanner.push(JSON.stringify(record) + '\n{bad}')) saved.push(value);
    }).toThrow(VariationScanError);
    expect(saved).toEqual([record]);
  });

  it('reports truncated final objects and fences without discarding records', () => {
    const scanner = new VariationScanner();
    expect([...scanner.push(JSON.stringify(record) + '\n{"name":"unfinished')]).toEqual([record]);
    expect(() => scanner.finish()).toThrow('cut off');
    const fenced = new VariationScanner();
    expect([...fenced.push('```json\n' + JSON.stringify(record))]).toEqual([record]);
    expect(() => fenced.finish()).toThrow('closing fence');
  });

  it.each([
    { name: '', html: '<div></div>' }, { name: 'x'.repeat(101), html: '<div></div>' },
    { name: 'bad\nname', html: '<div></div>' }, { name: 'name', html: '' },
    { name: 'name', html: 'I cannot provide that.' }, { name: 'name', html: 12 },
  ])('rejects invalid record fields', (invalid) => {
    expect(() => [...new VariationScanner().push(JSON.stringify(invalid))]).toThrow(VariationScanError);
  });

  it('strips only outer HTML fences when validating a record', () => {
    expect([...new VariationScanner().push(JSON.stringify({ name: ' Ink ', html: '```html\n<div>```</div>\n```' }))])
      .toEqual([{ name: 'Ink', html: '<div>```</div>' }]);
  });

  it('bounds individual buffers, total text, HTML, and record count', () => {
    const buffered = new VariationScanner({ maxBufferChars: 32 });
    expect([...buffered.push('{"name":"')]).toEqual([]);
    expect(() => [...buffered.push('x'.repeat(33))]).toThrow('buffer limit');
    expect(() => [...new VariationScanner({ maxOutputChars: 32 }).push(' '.repeat(33))]).toThrow('output limit');
    expect(() => [...new VariationScanner({ maxHtmlChars: 10 }).push(JSON.stringify(record))]).toThrow('HTML limit');
    const scanner = new VariationScanner();
    const saved: VariationRecord[] = [];
    expect(() => {
      for (const value of scanner.push(JSON.stringify(record).repeat(4))) saved.push(value);
    }).toThrow('too many');
    expect(saved).toHaveLength(3);
  });

  it.each(['[', 'some prose', '```html\n', '```json\n{}\n```\ntrailing'])('rejects unsupported framing %j', (text) => {
    expect(() => [...new VariationScanner().push(text)]).toThrow(VariationScanError);
  });
});
