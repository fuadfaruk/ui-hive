import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, redact } from '../shared/diagnostics.js';

export type RunLogKind = 'generate' | 'variations' | 'ideas';
export type RunLogPhase = 'plan' | 'generate' | 'variations' | 'ideas';
export type RunLogStatus = 'complete' | 'incomplete' | 'error' | 'cancelled';
export type RunLogSeverity = 'warning' | 'error';

export interface RunLogMeta {
  protocol: string;
  model: string;
  resolvedUrl: string;
  sessionId?: string;
  artifactId?: string;
  artifactIds?: readonly string[];
  prompt?: string;
  promptChars: number;
  startedAt: string;
}

// Provider-level observation attached to an exchange or failure. Numeric/boolean
// fields bypass `field()` (they are not strings); the two string fields are redacted.
export interface RunLogProviderMeta {
  finishReason?: string;
  reasoning?: boolean;
  deltas?: number;
  endReason?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RunLogExchange extends RunLogProviderMeta {
  phase: RunLogPhase;
  label: string;
  artifactId?: string;
  system: string;
  user: string;
  output: string;
}

export interface RunLogFailure extends RunLogProviderMeta {
  phase: RunLogPhase;
  label: string;
  artifactId?: string;
  site: string;
  severity: RunLogSeverity;
  status?: RunLogStatus;
  message: string;
  raw: string;
}

export interface RunLogFinish {
  status: RunLogStatus;
  elapsedMs: number;
}

/** Independent, full-fidelity, persisted sink beside the in-memory browser inspector. */
export interface RunLog {
  meta(info: RunLogMeta): void;
  exchange(info: RunLogExchange): void;
  failure(info: RunLogFailure): void;
  finish(info: RunLogFinish): void;
  close(): Promise<void>;
}

export interface RunLogOptions {
  operationId: string;
  kind: RunLogKind;
  directory?: string;
  enabled?: boolean;
  now?: () => number;
}

// Per-field cap for a single JSONL string value. Larger fields keep their head and
// tail with an explicit omission marker; the full length survives in the *Chars field.
const FIELD_CAP = 256 * 1024;
const CLIP_OVERHEAD = 48;

function clip(value: string): { text: string; truncated: boolean } {
  if (value.length <= FIELD_CAP) return { text: value, truncated: false };
  const head = Math.max(0, Math.ceil((FIELD_CAP - CLIP_OVERHEAD) / 2));
  const tail = Math.max(0, FIELD_CAP - CLIP_OVERHEAD - head);
  const omitted = value.length - head - tail;
  return {
    text: `${value.slice(0, head)}…[${omitted} chars omitted]…${value.slice(value.length - tail)}`,
    truncated: true,
  };
}

const noop: RunLog = { meta() {}, exchange() {}, failure() {}, finish() {}, close: async () => undefined };

/**
 * Best-effort JSONL writer. Every call is a no-op when the logger is disabled, and
 * every filesystem fault is swallowed (mirroring `traceSafe` in providers.ts) so a
 * diagnostic failure can never fail or slow the paid request.
 */
export function createRunLog(options: RunLogOptions): RunLog {
  if (options.enabled === false) return noop;
  const now = options.now ?? Date.now;
  const directory = options.directory ?? fileURLToPath(new URL('../logs/', import.meta.url));
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const file = join(directory, `${stamp}_${options.kind}_${options.operationId}.jsonl`);

  let queue: Promise<void> = Promise.resolve();
  let directoryReady: Promise<void> | undefined;
  let warned = false;

  function warnOnce(error: unknown): void {
    if (warned) return;
    warned = true;
    try {
      log.server('warn', 'runlog', 'file logging stopped after an I/O failure', { operationId: options.operationId, error });
    } catch {
      // Diagnostics must never break the pipeline.
    }
  }

  function field(value: string): { text: string; chars: number; truncated: boolean } {
    const clean = redact(value);
    const clipped = clip(clean);
    return { text: clipped.text, chars: clean.length, truncated: clipped.truncated };
  }

  function provider(info: RunLogProviderMeta): Record<string, unknown> {
    return {
      ...(info.finishReason !== undefined ? { finishReason: redact(info.finishReason) } : {}),
      ...(info.reasoning !== undefined ? { reasoning: info.reasoning } : {}),
      ...(info.deltas !== undefined ? { deltas: info.deltas } : {}),
      ...(info.endReason !== undefined ? { endReason: redact(info.endReason) } : {}),
      ...(info.maxTokens !== undefined ? { maxTokens: info.maxTokens } : {}),
      ...(info.temperature !== undefined ? { temperature: info.temperature } : {}),
    };
  }

  function append(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`;
    queue = queue.then(async () => {
      try {
        directoryReady ??= fs.mkdir(directory, { recursive: true }).then(() => undefined);
        void directoryReady.catch(() => undefined);
        await directoryReady;
        await fs.appendFile(file, line, 'utf8');
      } catch (error) {
        warnOnce(error);
      }
    });
  }

  function base(type: string): Record<string, unknown> {
    return { ts: new Date(now()).toISOString(), operationId: options.operationId, kind: options.kind, type };
  }

  return {
    meta(info) {
      const prompt = info.prompt === undefined ? undefined : field(info.prompt);
      append({
        ...base('meta'),
        protocol: redact(info.protocol),
        model: redact(info.model),
        resolvedUrl: redact(info.resolvedUrl),
        ...(info.sessionId !== undefined ? { sessionId: redact(info.sessionId) } : {}),
        ...(info.artifactId !== undefined ? { artifactId: redact(info.artifactId) } : {}),
        ...(info.artifactIds !== undefined ? { artifactIds: info.artifactIds.map((value) => redact(value)) } : {}),
        ...(prompt ? { prompt: prompt.text, ...(prompt.truncated ? { truncated: true } : {}) } : {}),
        promptChars: info.promptChars,
        startedAt: info.startedAt,
      });
    },
    exchange(info) {
      const system = field(info.system);
      const user = field(info.user);
      const output = field(info.output);
      append({
        ...base('exchange'),
        phase: info.phase,
        label: redact(info.label),
        ...(info.artifactId !== undefined ? { artifactId: redact(info.artifactId) } : {}),
        system: system.text,
        user: user.text,
        output: output.text,
        outputChars: output.chars,
        ...(system.truncated || user.truncated || output.truncated ? { truncated: true } : {}),
        ...provider(info),
      });
    },
    failure(info) {
      const raw = field(info.raw);
      append({
        ...base('failure'),
        phase: info.phase,
        label: redact(info.label),
        ...(info.artifactId !== undefined ? { artifactId: redact(info.artifactId) } : {}),
        site: info.site,
        severity: info.severity,
        ...(info.status !== undefined ? { status: info.status } : {}),
        message: redact(info.message),
        raw: raw.text,
        rawChars: raw.chars,
        ...(raw.truncated ? { truncated: true } : {}),
        ...provider(info),
      });
    },
    finish(info) {
      append({ ...base('finish'), status: info.status, elapsedMs: info.elapsedMs });
    },
    async close() {
      await queue.catch(() => undefined);
    },
  };
}
