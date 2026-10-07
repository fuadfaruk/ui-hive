/**
 * Structured, secret-safe diagnostics for the UIHive generation pipeline.
 *
 * Every layer (browser, local server, provider stream, SSE framing) writes to a
 * single prefixed channel so a failed run can be reconstructed end to end.
 * Logging is on by default during development and can be switched off with
 * UI_MAKER_DEBUG=0 (server) or `window.__UI_MAKER_DEBUG = false` (browser).
 * It is disabled automatically under Vitest so test output stays clean.
 */

export type DiagnosticsLevel = 'debug' | 'info' | 'warn' | 'error';

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

function processEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  return proc?.env?.[name];
}

function browserOverride(): boolean | undefined {
  const value = (globalThis as { __UI_MAKER_DEBUG?: unknown }).__UI_MAKER_DEBUG;
  return typeof value === 'boolean' ? value : undefined;
}

function parseFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '0' || value.toLowerCase() === 'false' || value.toLowerCase() === 'no') return false;
  return true;
}

const override = parseFlag(processEnv('UI_MAKER_DEBUG'));
const serverFlag = parseFlag(processEnv('UI_MAKER_DEBUG_SERVER'));
const inTest = processEnv('VITEST') !== undefined || processEnv('NODE_ENV') === 'test';

// In the browser an explicit window flag wins; otherwise default on.
// On the server, tests are silent unless logging is forced on.
export const diagnosticsEnabled = browserOverride() ?? override ?? (inTest ? false : true);
export const serverDiagnosticsEnabled = browserOverride() ?? serverFlag ?? override ?? (inTest ? false : true);

const PREFIX = '[uihive]';
const MAX_DATA = 4000;
const MAX_BUFFER = 4000;
const secrets = new Set<string>();
const buffer: string[] = [];

/** Register a credential so it can never appear in a diagnostic line. */
export function registerSecret(value: string | undefined): void {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

function mask(text: string): string {
  let result = text;
  for (const secret of secrets) {
    if (result.includes(secret)) result = result.split(secret).join('[redacted]');
  }
  return result;
}

/** Remove every registered credential from arbitrary text, such as a traced provider body. */
export function redact(text: string): string {
  return mask(text);
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const extra: Record<string, unknown> = { name: value.name, message: value.message };
    const status = (value as { status?: unknown }).status;
    const code = (value as { code?: unknown }).code;
    if (status !== undefined) extra.status = status;
    if (code !== undefined) extra.code = code;
    return JSON.stringify(extra);
  }
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (item instanceof Error) {
        return { name: item.name, message: item.message, status: (item as { status?: unknown }).status, code: (item as { code?: unknown }).code };
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    text = undefined;
  }
  return text === undefined ? String(value) : text;
}

function record(level: DiagnosticsLevel, scope: string, message: string, data?: unknown): string {
  const detail = data === undefined ? '' : ` :: ${describe(data).slice(0, MAX_DATA)}`;
  return mask(`[${new Date().toISOString()}] ${PREFIX}[${level}] ${scope} :: ${message}${detail}`);
}

function write(enabled: boolean, level: DiagnosticsLevel, scope: string, message: string, data?: unknown): void {
  if (!enabled) return;
  const line = record(level, scope, message, data);
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug(scope: string, message: string, data?: unknown): void {
    write(diagnosticsEnabled, 'debug', scope, message, data);
  },
  info(scope: string, message: string, data?: unknown): void {
    write(diagnosticsEnabled, 'info', scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown): void {
    write(diagnosticsEnabled, 'warn', scope, message, data);
  },
  error(scope: string, message: string, data?: unknown): void {
    write(diagnosticsEnabled, 'error', scope, message, data);
  },
  server(level: DiagnosticsLevel, scope: string, message: string, data?: unknown): void {
    write(serverDiagnosticsEnabled, level, scope, message, data);
  },
};

/** Snapshot of everything logged in this process, newest last. */
export function diagnosticsDump(): string {
  return buffer.join('\n');
}

export function diagnosticsClear(): void {
  buffer.length = 0;
}
