import { randomUUID } from 'node:crypto';
import { log, redact } from '../shared/diagnostics.js';
import { extractHtml, isHtmlSource, stripOuterFences, VariationScanner, VariationScanError } from '../shared/stream.js';
import { LIMITS } from '../shared/types.js';
import type { GenerationEvent, GenerationRequest, IdeasRequest, Trace, TracePhase, VariationsRequest } from '../shared/types.js';
import { ProviderError } from './providers.js';
import type { ProviderClient, ProviderTrace } from './providers.js';
import { HTML_SYSTEM, IDEAS_SYSTEM, PLAN_SYSTEM, VARIATIONS_SYSTEM, htmlPrompt, planPrompt, variationsPrompt } from './prompts.js';

export type Emit = (event: GenerationEvent) => Promise<void>;
type DoneStatus = Extract<GenerationEvent, { type: 'done' }>['status'];
const fallbackNames: [string, string, string] = ['Layered Paper', 'Etched Metal', 'Kinetic Wireframe'];

// Turn the app-level inspector sink into the provider-level hook. Credentials are
// masked here because providers.ts deliberately hands over unredacted bytes.
function tracer(trace: Trace | undefined, phase: TracePhase, label: string, artifactId?: string): ProviderTrace | undefined {
  if (!trace) return undefined;
  return (entry) => {
    const redacted = redact(entry.text);
    const text = redacted.length > LIMITS.traceChars ? redacted.slice(0, LIMITS.traceChars) : redacted;
    trace({
      at: Date.now(), dir: entry.dir, channel: entry.channel, phase, label, text,
      ...(artifactId ? { artifactId } : {}),
      ...(text.length !== redacted.length ? { truncated: true } : {}),
    });
  };
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
}

function failure(error: unknown, signal: AbortSignal, partial = false): { status: 'error' | 'incomplete' | 'cancelled'; message: string } {
  if (signal.aborted) return { status: 'cancelled', message: 'The request was cancelled.' };
  if (error instanceof ProviderError || error instanceof VariationScanError) return error;
  return { status: partial ? 'incomplete' : 'error', message: 'The request failed before a valid result was complete.' };
}

function strings(text: string, maxCount: number, maxLength: number): string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stripOuterFences(text).trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || !value.length || value.length > maxCount ||
    !value.every((entry) => typeof entry === 'string' && entry.trim() && entry.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(entry))) return undefined;
  const result = (value as string[]).map((entry) => entry.trim());
  if (new Set(result.map((entry) => entry.toLowerCase())).size !== result.length) return undefined;
  return result;
}

export async function runGeneration(client: ProviderClient, request: GenerationRequest, signal: AbortSignal, emit: Emit, trace?: Trace): Promise<void> {
  const { operationId, sessionId, prompt } = request;
  const artifactIds = [...request.artifactIds];
  let status: DoneStatus = 'error';
  log.server('info', 'generation', 'run start', { operationId, sessionId, promptChars: prompt.length, artifactIds });
  try {
    let names: [string, string, string];
    try {
      active(signal);
      log.server('debug', 'generation', 'requesting style plan', { operationId });
      const plan = await client.complete({ system: PLAN_SYSTEM, user: planPrompt(prompt), signal, maxTokens: 256, trace: tracer(trace, 'plan', 'plan') });
      active(signal);
      if (!plan.trim()) throw new ProviderError('error', 'The provider returned no style plan.');
      const parsed = strings(plan, 3, 100);
      names = parsed?.length === 3 ? parsed as [string, string, string] : [...fallbackNames];
      log.server('info', 'generation', 'style plan resolved', { operationId, parsedNames: parsed?.length ?? 0, fallback: parsed?.length !== 3, names });
      if (parsed?.length !== 3) {
        await emit({ type: 'warning', operationId, sessionId, message: 'The style names were malformed. Using three preset material directions.' });
      }
      active(signal);
    } catch (error) {
      const result = failure(error, signal);
      status = result.status;
      log.server('warn', 'generation', 'style plan failed before fan-out', { operationId, status: result.status, error, signalAborted: signal.aborted });
      for (const artifactId of artifactIds) {
        await emit({ type: 'artifact-error', operationId, sessionId, artifactId, status: result.status, message: result.message });
      }
      return;
    }
    await emit({ type: 'plan', operationId, sessionId, names });
    const runArtifact = async (artifactId: string, index: number): Promise<DoneStatus> => {
      let html = '';
      let deltas = 0;
      try {
        active(signal);
        log.server('debug', 'generation', 'artifact stream start', { operationId, artifactId, index, styleName: names[index] });
        for await (const delta of client.stream({ system: HTML_SYSTEM, user: htmlPrompt(prompt, names[index]), signal, trace: tracer(trace, 'generate', names[index], artifactId) })) {
          active(signal);
          if (html.length + delta.length > LIMITS.html) {
            throw new ProviderError('incomplete', 'This design exceeded the safe HTML size limit.');
          }
          html += delta;
          if (delta) {
            deltas++;
            const event = { type: 'artifact-delta' as const, operationId, sessionId, artifactId, delta };
            if (JSON.stringify(event).length > LIMITS.sseEvent) {
              throw new ProviderError('incomplete', 'This design exceeded the safe event size limit.');
            }
            await emit(event);
          }
        }
        active(signal);
        const final = extractHtml(html);
        if (!final.trim() || !isHtmlSource(final)) {
          throw new ProviderError('error', 'The provider did not return usable HTML for this design.');
        }
        const event = { type: 'artifact-done' as const, operationId, sessionId, artifactId, html: final };
        if (JSON.stringify(event).length > LIMITS.sseEvent) {
          throw new ProviderError('incomplete', 'This design exceeded the safe event size limit.');
        }
        log.server('info', 'generation', 'artifact complete', { operationId, artifactId, index, deltas, htmlChars: final.length });
        await emit(event);
        return 'complete';
      } catch (error) {
        const result = failure(error, signal, !!html);
        log.server('warn', 'generation', 'artifact failed', {
          operationId, artifactId, index, deltas, partialHtmlChars: html.length,
          status: result.status, message: result.message, error, signalAborted: signal.aborted,
        });
        await emit({ type: 'artifact-error', operationId, sessionId, artifactId, status: result.status, message: result.message });
        return result.status;
      }
    };
    const statuses: DoneStatus[] = [];
    for (let index = 0; index < artifactIds.length; index++) {
      // Each artifact calls active() first, so after a cancellation every remaining
      // artifact still emits artifact-error with status cancelled.
      statuses.push(await runArtifact(artifactIds[index], index));
    }
    status = statuses.every((value) => value === 'complete') ? 'complete'
      : statuses.includes('cancelled') ? 'cancelled'
        : statuses.some((value) => value === 'complete' || value === 'incomplete') ? 'incomplete' : 'error';
    log.server('info', 'generation', 'fan-out settled', { operationId, statuses, status });
  } finally {
    log.server('info', 'generation', 'run done', { operationId, status: signal.aborted ? 'cancelled' : status, signalAborted: signal.aborted });
    await emit({ type: 'done', operationId, status: signal.aborted ? 'cancelled' : status });
  }
}

export async function runVariations(client: ProviderClient, request: VariationsRequest, signal: AbortSignal, emit: Emit, trace?: Trace): Promise<void> {
  const { operationId, sessionId, artifactId, prompt, html } = request;
  const scanner = new VariationScanner();
  let emitted = 0;
  let status: DoneStatus = 'error';
  log.server('info', 'variations', 'run start', { operationId, sessionId, artifactId, promptChars: prompt.length, sourceChars: html.length });
  try {
    active(signal);
    for await (const delta of client.stream({ system: VARIATIONS_SYSTEM, user: variationsPrompt(prompt, html), signal, trace: tracer(trace, 'variations', 'variations') })) {
      active(signal);
      for (const record of scanner.push(delta)) {
        active(signal);
        const event: GenerationEvent = {
          type: 'variation', operationId, sessionId,
          artifact: { id: randomUUID(), styleName: record.name, html: record.html, status: 'complete' },
        };
        if (JSON.stringify(event).length > LIMITS.sseEvent) {
          throw new ProviderError('incomplete', 'A variation exceeded the safe event size limit.');
        }
        log.server('debug', 'variations', 'record accepted', { operationId, index: emitted, name: record.name, htmlChars: record.html.length });
        await emit(event);
        emitted++;
      }
    }
    active(signal);
    scanner.finish();
    if (scanner.count !== 3) {
      throw new VariationScanError(scanner.count ? 'incomplete' : 'error', 'The provider did not return three complete variations.');
    }
    status = 'complete';
  } catch (error) {
    const result = failure(error, signal, emitted > 0);
    status = result.status === 'cancelled' ? 'cancelled' : emitted ? 'incomplete' : result.status;
    log.server('warn', 'variations', 'run failed', { operationId, emitted, status, message: result.message, error, signalAborted: signal.aborted });
    if (emitted) {
      await emit({ type: 'warning', operationId, sessionId, artifactId, message: result.message });
    } else {
      await emit({ type: 'error', operationId, message: result.message });
    }
  } finally {
    log.server('info', 'variations', 'run done', { operationId, status: signal.aborted ? 'cancelled' : status, emitted, signalAborted: signal.aborted });
    await emit({ type: 'done', operationId, status: signal.aborted ? 'cancelled' : status });
  }
}

export async function runIdeas(client: ProviderClient, request: IdeasRequest, signal: AbortSignal, emit: Emit, trace?: Trace): Promise<void> {
  const { operationId } = request;
  let status: DoneStatus = 'error';
  log.server('info', 'ideas', 'run start', { operationId });
  try {
    active(signal);
    const raw = await client.complete({ system: IDEAS_SYSTEM, user: 'Return fresh, varied interface ideas.', signal, maxTokens: 1536, trace: tracer(trace, 'ideas', 'ideas') });
    active(signal);
    const ideas = strings(raw, 20, 240);
    if (!ideas) throw new ProviderError('error', 'The provider returned an invalid list of ideas.');
    log.server('info', 'ideas', 'ideas accepted', { operationId, count: ideas.length });
    await emit({ type: 'ideas', operationId, ideas });
    status = 'complete';
  } catch (error) {
    const result = failure(error, signal);
    status = result.status;
    log.server('warn', 'ideas', 'run failed', { operationId, status, error, signalAborted: signal.aborted });
    await emit({ type: 'error', operationId, message: result.message });
  } finally {
    log.server('info', 'ideas', 'run done', { operationId, status: signal.aborted ? 'cancelled' : status, signalAborted: signal.aborted });
    await emit({ type: 'done', operationId, status: signal.aborted ? 'cancelled' : status });
  }
}
