import { randomUUID } from 'node:crypto';
import { log, redact } from '../shared/diagnostics.js';
import { extractHtml, extractJson, isCompleteHtml, isHtmlSource, salvageHtml, stripOuterFences, VariationScanner, VariationScanError } from '../shared/stream.js';
import { LIMITS } from '../shared/types.js';
import type { GenerationEvent, GenerationRequest, IdeasRequest, Trace, TracePhase, VariationsRequest } from '../shared/types.js';
import { ProviderError } from './providers.js';
import type { CompletionSummary, ProviderClient, ProviderTrace } from './providers.js';
import type { RunLog, RunLogFailure, RunLogSeverity, RunLogStatus } from './runlog.js';
import { HTML_SYSTEM, IDEAS_SYSTEM, PLAN_SYSTEM, VARIATIONS_SYSTEM, htmlPrompt, planPrompt, variationsPrompt } from './prompts.js';

// A partial result is the recoverable, prompt-tunable case; everything else is a hard error.
function severity(status: RunLogStatus): RunLogSeverity {
  return status === 'incomplete' ? 'warning' : 'error';
}

export type Emit = (event: GenerationEvent) => Promise<void>;
type DoneStatus = Extract<GenerationEvent, { type: 'done' }>['status'];
const fallbackNames: [string, string, string] = ['Layered Paper', 'Etched Metal', 'Kinetic Wireframe'];

// Explicit request parameters per phase. Code constants on purpose: the settings
// schema and settings UI stay unchanged. The Anthropic protocol still clamps
// maxTokens to the connection's anthropicMaxTokens.
const PARAMS = {
  plan: { maxTokens: 1024, temperature: 0 },
  generate: { maxTokens: 16384, temperature: 0.2 },
  variations: { maxTokens: 16384, temperature: 0.2 },
  ideas: { maxTokens: 4096, temperature: 0 },
} as const;

// Turn the last provider summary into run-log fields. Empty when the client never
// invoked the summary hook (including the test doubles).
function observed(summary: CompletionSummary | undefined): Pick<RunLogFailure, 'finishReason' | 'reasoning' | 'deltas' | 'endReason'> {
  if (!summary) return {};
  return {
    finishReason: summary.finishReason,
    reasoning: summary.reasoning,
    deltas: summary.deltas,
    endReason: summary.endReason,
  };
}

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
    // A model that ignores "return only JSON" often wraps the array in prose; a
    // balanced scan recovers the embedded span when the whole-string parse fails.
    const extracted = extractJson(text);
    if (extracted === undefined) return undefined;
    try {
      value = JSON.parse(extracted);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value) || !value.length || value.length > maxCount ||
    !value.every((entry) => typeof entry === 'string' && entry.trim() && entry.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(entry))) return undefined;
  const result = (value as string[]).map((entry) => entry.trim());
  if (new Set(result.map((entry) => entry.toLowerCase())).size !== result.length) return undefined;
  return result;
}

export async function runGeneration(client: ProviderClient, request: GenerationRequest, signal: AbortSignal, emit: Emit, trace?: Trace, logger?: RunLog): Promise<void> {
  const { operationId, sessionId, prompt } = request;
  const artifactIds = [...request.artifactIds];
  let status: DoneStatus = 'error';
  log.server('info', 'generation', 'run start', { operationId, sessionId, promptChars: prompt.length, artifactIds });
  try {
    let names: [string, string, string];
    try {
      active(signal);
      log.server('debug', 'generation', 'requesting style plan', { operationId });
      // Hoisted so the logged input is byte-identical to the request body.
      const planUser = planPrompt(prompt);
      let plan: string;
      let planSummary: CompletionSummary | undefined;
      try {
        plan = await client.complete({
          system: PLAN_SYSTEM, user: planUser, signal,
          maxTokens: PARAMS.plan.maxTokens, temperature: PARAMS.plan.temperature,
          trace: tracer(trace, 'plan', 'plan'),
          summary: (info) => { planSummary = info; },
        });
      } catch (error) {
        const result = failure(error, signal);
        logger?.failure({ phase: 'plan', label: 'plan', site: 'plan-error', severity: severity(result.status), status: result.status, message: result.message, raw: '', ...PARAMS.plan, ...observed(planSummary) });
        throw error;
      }
      active(signal);
      logger?.exchange({ phase: 'plan', label: 'plan', system: PLAN_SYSTEM, user: planUser, output: plan, ...PARAMS.plan, ...observed(planSummary) });
      if (!plan.trim()) {
        logger?.failure({ phase: 'plan', label: 'plan', site: 'plan-empty', severity: 'error', status: 'error', message: 'The provider returned no style plan.', raw: plan, ...PARAMS.plan, ...observed(planSummary) });
        throw new ProviderError('error', 'The provider returned no style plan.');
      }
      const parsed = strings(plan, 3, 100);
      names = parsed?.length === 3 ? parsed as [string, string, string] : [...fallbackNames];
      log.server('info', 'generation', 'style plan resolved', { operationId, parsedNames: parsed?.length ?? 0, fallback: parsed?.length !== 3, names });
      if (parsed?.length !== 3) {
        logger?.failure({ phase: 'plan', label: 'plan', site: 'plan-invalid', severity: 'warning', message: 'The style names were not exactly three unique values.', raw: plan, ...PARAMS.plan, ...observed(planSummary) });
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
      let site = 'artifact-error';
      let summary: CompletionSummary | undefined;
      // Hoisted so the logged input is byte-identical to the request body.
      const system = HTML_SYSTEM;
      const user = htmlPrompt(prompt, names[index]);
      try {
        active(signal);
        log.server('debug', 'generation', 'artifact stream start', { operationId, artifactId, index, styleName: names[index] });
        for await (const delta of client.stream({
          system, user, signal,
          maxTokens: PARAMS.generate.maxTokens, temperature: PARAMS.generate.temperature,
          trace: tracer(trace, 'generate', names[index], artifactId),
          summary: (info) => { summary = info; },
        })) {
          active(signal);
          if (html.length + delta.length > LIMITS.html) {
            site = 'artifact-limit';
            throw new ProviderError('incomplete', 'This design exceeded the safe HTML size limit.');
          }
          html += delta;
          if (delta) {
            deltas++;
            const event = { type: 'artifact-delta' as const, operationId, sessionId, artifactId, delta };
            if (JSON.stringify(event).length > LIMITS.sseEvent) {
              site = 'artifact-limit';
              throw new ProviderError('incomplete', 'This design exceeded the safe event size limit.');
            }
            await emit(event);
          }
        }
        active(signal);
        logger?.exchange({ phase: 'generate', label: names[index], artifactId, system, user, output: html, ...PARAMS.generate, ...observed(summary) });
        const final = extractHtml(html);
        if (!final.trim() || !isHtmlSource(final)) {
          site = 'artifact-invalid';
          throw new ProviderError('error', 'The provider did not return usable HTML for this design.');
        }
        if (!isCompleteHtml(final)) {
          // Prose/empty output stays a hard failure above; a document that started
          // correctly but was cut off is salvaged and rendered as a partial design.
          const repaired = salvageHtml(html) ?? final;
          const message = 'This design was truncated and rendered as a partial document.';
          logger?.failure({ phase: 'generate', label: names[index], artifactId, site: 'artifact-truncated', severity: 'warning', status: 'incomplete', message, raw: html, ...PARAMS.generate, ...observed(summary) });
          const event = { type: 'artifact-done' as const, operationId, sessionId, artifactId, html: repaired, status: 'incomplete' as const };
          if (JSON.stringify(event).length > LIMITS.sseEvent) {
            site = 'artifact-limit';
            throw new ProviderError('incomplete', 'This design exceeded the safe event size limit.');
          }
          log.server('info', 'generation', 'artifact salvaged', { operationId, artifactId, index, deltas, htmlChars: repaired.length });
          await emit(event);
          await emit({ type: 'warning', operationId, sessionId, artifactId, message });
          return 'incomplete';
        }
        const event = { type: 'artifact-done' as const, operationId, sessionId, artifactId, html: final };
        if (JSON.stringify(event).length > LIMITS.sseEvent) {
          site = 'artifact-limit';
          throw new ProviderError('incomplete', 'This design exceeded the safe event size limit.');
        }
        log.server('info', 'generation', 'artifact complete', { operationId, artifactId, index, deltas, htmlChars: final.length });
        await emit(event);
        return 'complete';
      } catch (error) {
        const result = failure(error, signal, !!html);
        logger?.failure({ phase: 'generate', label: names[index], artifactId, site, severity: severity(result.status), status: result.status, message: result.message, raw: html, ...PARAMS.generate, ...observed(summary) });
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

export async function runVariations(client: ProviderClient, request: VariationsRequest, signal: AbortSignal, emit: Emit, trace?: Trace, logger?: RunLog): Promise<void> {
  const { operationId, sessionId, artifactId, prompt, html } = request;
  const scanner = new VariationScanner();
  let emitted = 0;
  let status: DoneStatus = 'error';
  let output = '';
  let site = 'variations-error';
  let exchanged = false;
  let summary: CompletionSummary | undefined;
  // Hoisted so the logged input is byte-identical to the request body.
  const system = VARIATIONS_SYSTEM;
  const user = variationsPrompt(prompt, html);
  const logExchange = () => {
    if (exchanged) return;
    exchanged = true;
    logger?.exchange({ phase: 'variations', label: 'variations', system, user, output, ...PARAMS.variations, ...observed(summary) });
  };
  log.server('info', 'variations', 'run start', { operationId, sessionId, artifactId, promptChars: prompt.length, sourceChars: html.length });
  try {
    active(signal);
    for await (const delta of client.stream({
      system, user, signal,
      maxTokens: PARAMS.variations.maxTokens, temperature: PARAMS.variations.temperature,
      trace: tracer(trace, 'variations', 'variations'),
      summary: (info) => { summary = info; },
    })) {
      active(signal);
      output += delta;
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
    logExchange();
    scanner.finish();
    if (scanner.count !== 3) {
      site = 'variations-count';
      throw new VariationScanError(scanner.count ? 'incomplete' : 'error', 'The provider did not return three complete variations.');
    }
    status = 'complete';
  } catch (error) {
    const result = failure(error, signal, emitted > 0);
    status = result.status === 'cancelled' ? 'cancelled' : emitted ? 'incomplete' : result.status;
    if (site === 'variations-error' && error instanceof VariationScanError) site = 'variations-scan';
    logExchange();
    logger?.failure({ phase: 'variations', label: 'variations', site, severity: severity(result.status), status: result.status, message: result.message, raw: output, ...PARAMS.variations, ...observed(summary) });
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

export async function runIdeas(client: ProviderClient, request: IdeasRequest, signal: AbortSignal, emit: Emit, trace?: Trace, logger?: RunLog): Promise<void> {
  const { operationId } = request;
  let status: DoneStatus = 'error';
  let raw = '';
  let invalidLogged = false;
  let summary: CompletionSummary | undefined;
  log.server('info', 'ideas', 'run start', { operationId });
  try {
    active(signal);
    // Hoisted so the logged input is byte-identical to the request body.
    const system = IDEAS_SYSTEM;
    const user = 'Return fresh, varied interface ideas.';
    raw = await client.complete({
      system, user, signal,
      maxTokens: PARAMS.ideas.maxTokens, temperature: PARAMS.ideas.temperature,
      trace: tracer(trace, 'ideas', 'ideas'),
      summary: (info) => { summary = info; },
    });
    active(signal);
    logger?.exchange({ phase: 'ideas', label: 'ideas', system, user, output: raw, ...PARAMS.ideas, ...observed(summary) });
    const ideas = strings(raw, 20, 240);
    if (!ideas) {
      logger?.failure({ phase: 'ideas', label: 'ideas', site: 'ideas-invalid', severity: 'warning', status: 'error', message: 'The provider returned an invalid list of ideas.', raw, ...PARAMS.ideas, ...observed(summary) });
      invalidLogged = true;
      throw new ProviderError('error', 'The provider returned an invalid list of ideas.');
    }
    log.server('info', 'ideas', 'ideas accepted', { operationId, count: ideas.length });
    await emit({ type: 'ideas', operationId, ideas });
    status = 'complete';
  } catch (error) {
    const result = failure(error, signal);
    status = result.status;
    if (!invalidLogged) {
      logger?.failure({ phase: 'ideas', label: 'ideas', site: 'ideas-error', severity: severity(result.status), status: result.status, message: result.message, raw, ...PARAMS.ideas, ...observed(summary) });
    }
    log.server('warn', 'ideas', 'run failed', { operationId, status, error, signalAborted: signal.aborted });
    await emit({ type: 'error', operationId, message: result.message });
  } finally {
    log.server('info', 'ideas', 'run done', { operationId, status: signal.aborted ? 'cancelled' : status, signalAborted: signal.aborted });
    await emit({ type: 'done', operationId, status: signal.aborted ? 'cancelled' : status });
  }
}
