import { validateSettings, resolveRequestUrl } from '../shared/connection';
import { log } from '../shared/diagnostics';
import { readSse } from '../shared/stream';
import { LIMITS } from '../shared/types';
import type {
  Artifact, Bootstrap, ConnectionSettings, GenerationEvent, GenerationRequest,
  IdeasRequest, PublicConnection, VariationsRequest,
} from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 16000): value is string {
  return typeof value === 'string' && value.length <= max;
}

function id(value: unknown): value is string {
  return text(value, 160) && value.length > 0;
}

function publicConnection(value: unknown): PublicConnection {
  if (!record(value) || typeof value.hasKey !== 'boolean' ||
    (value.resolvedUrl !== null && !text(value.resolvedUrl, 4096))) {
    throw new ApiError('The local server returned an invalid connection.');
  }
  const settings = value.settings === null ? null : validateSettings(value.settings);
  if ((value.hasKey && !settings) || (settings && value.resolvedUrl !== resolveRequestUrl(settings.protocol, settings.apiUrl))) {
    throw new ApiError('The local server returned inconsistent connection settings.');
  }
  return { settings, hasKey: value.hasKey, resolvedUrl: value.resolvedUrl as string | null };
}

async function jsonResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    value = await response.json();
  } catch {
    throw new ApiError(`The local server returned an unreadable response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    throw new ApiError(record(value) && text(value.error) && value.error.trim()
      ? value.error : `The local request failed (HTTP ${response.status}).`, response.status);
  }
  return value;
}

// StrictMode shares the same non-paid bootstrap request. Never cache keys or drafts.
let bootstrapRequest: Promise<Bootstrap> | undefined;

export function getBootstrap(): Promise<Bootstrap> {
  bootstrapRequest ??= fetch('/api/bootstrap', {
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(LIMITS.connectMs),
  }).then(jsonResponse).then((value) => {
    if (!record(value) || !id(value.csrfToken) ||
      (value.storageError !== undefined && (!text(value.storageError) || !value.storageError.trim()))) {
      throw new ApiError('The local server returned an invalid startup response.');
    }
    return {
      csrfToken: value.csrfToken,
      connection: publicConnection(value.connection),
      ...(value.storageError !== undefined ? { storageError: value.storageError as string } : {}),
    };
  });
  return bootstrapRequest;
}

async function mutate(path: string, token: string, body: unknown, method = 'POST', signal?: AbortSignal, timeoutMs: number = LIMITS.inactivityMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return jsonResponse(await fetch(path, {
    method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-UI-Maker-Token': token },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }));
}

export async function saveConnection(
  token: string, settings: ConnectionSettings,
  key: { action: 'replace'; value: string } | { action: 'keep' }, signal?: AbortSignal,
): Promise<PublicConnection> {
  return publicConnection(await mutate('/api/connection', token, { settings, key }, 'POST', signal));
}

export async function testConnection(
  token: string, settings: ConnectionSettings,
  key: { action: 'replace'; value: string } | { action: 'keep' }, signal?: AbortSignal,
): Promise<string> {
  // A slow provider may legitimately wait past the default inactivity budget for its
  // first byte, so let the draft's first-byte budget extend the client-side cap.
  const result = await mutate('/api/connection/test', token, { settings, key }, 'POST', signal,
    (settings.firstByteTimeoutMs ?? LIMITS.connectMs) + LIMITS.inactivityMs);
  if (!record(result) || result.ok !== true || !text(result.message)) {
    throw new ApiError('The local server did not confirm a successful connection test.');
  }
  return result.message;
}

export async function forgetConnection(token: string, signal?: AbortSignal): Promise<PublicConnection> {
  return publicConnection(await mutate('/api/connection', token, {}, 'DELETE', signal));
}

export async function cancelOperation(token: string, operationId: string): Promise<void> {
  await mutate(`/api/operations/${encodeURIComponent(operationId)}/cancel`, token, {});
}

function validArtifact(value: unknown): value is Artifact {
  return record(value) && id(value.id) && text(value.styleName, 300) && !!value.styleName.trim() &&
    text(value.html, LIMITS.html) &&
    typeof value.status === 'string' && ['queued', 'streaming', 'complete', 'incomplete', 'error', 'cancelled'].includes(value.status) &&
    (value.error === undefined || text(value.error));
}

export function parseGenerationEvent(data: string): GenerationEvent {
  let event: unknown;
  try { event = JSON.parse(data); } catch { throw new ApiError('The generation stream contained malformed JSON.'); }
  if (!record(event) || !id(event.operationId) || !text(event.type, 40)) {
    throw new ApiError('The generation stream contained an invalid event.');
  }
  const artifactTarget = id(event.sessionId) && id(event.artifactId);
  let valid = false;
  switch (event.type) {
    case 'plan':
      valid = id(event.sessionId) && Array.isArray(event.names) && event.names.length === 3 &&
        event.names.every((name) => text(name, 300) && !!name.trim());
      break;
    case 'trace': {
      const entry = record(event.entry) ? event.entry : undefined;
      valid = !!entry &&
        (entry.dir === 'in' || entry.dir === 'out') &&
        (entry.channel === 'request' || entry.channel === 'response' || entry.channel === 'frame') &&
        (entry.phase === 'plan' || entry.phase === 'generate' || entry.phase === 'variations' || entry.phase === 'ideas') &&
        text(entry.label, 300) && !!entry.label.trim() &&
        text(entry.text, LIMITS.traceChars) &&
        typeof entry.at === 'number' && Number.isFinite(entry.at) &&
        (entry.artifactId === undefined || id(entry.artifactId)) &&
        (entry.truncated === undefined || typeof entry.truncated === 'boolean');
      break;
    }
    case 'artifact-delta': valid = artifactTarget && text(event.delta, LIMITS.html); break;
    case 'artifact-done': valid = artifactTarget && text(event.html, LIMITS.html); break;
    case 'artifact-error':
      valid = artifactTarget && typeof event.status === 'string' && ['error', 'incomplete', 'cancelled'].includes(event.status) && text(event.message) && !!event.message.trim();
      break;
    case 'variation': valid = id(event.sessionId) && validArtifact(event.artifact); break;
    case 'ideas':
      valid = Array.isArray(event.ideas) && event.ideas.length <= 40 &&
        event.ideas.every((idea) => text(idea, LIMITS.prompt) && !!idea.trim());
      break;
    case 'warning':
      valid = text(event.message) && !!event.message.trim() && (event.sessionId === undefined || id(event.sessionId)) &&
        (event.artifactId === undefined || id(event.artifactId));
      break;
    case 'error': valid = text(event.message) && !!event.message.trim(); break;
    case 'done': valid = typeof event.status === 'string' && ['complete', 'incomplete', 'error', 'cancelled'].includes(event.status); break;
  }
  if (!valid) throw new ApiError(`The generation stream contained an invalid ${event.type || 'unknown'} event.`);
  return event as GenerationEvent;
}

export async function* generationEvents(
  path: 'generate' | 'variations' | 'ideas', token: string,
  body: GenerationRequest | VariationsRequest | IdeasRequest, signal: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  const connectionTimeout = new AbortController();
  const label = `client:${path}`;
  log.info('client', `${label}: opening generation stream`, { operationId: body.operationId, connectMs: LIMITS.connectMs });
  const timer = window.setTimeout(() => connectionTimeout.abort(new Error('The local connection timed out.')), LIMITS.connectMs);
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-UI-Maker-Token': token,
      },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, connectionTimeout.signal]),
    });
  } catch (error) {
    log.error('client', `${label}: request failed before a response`, { operationId: body.operationId, error, signalAborted: signal.aborted });
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
  log.info('client', `${label}: response received`, {
    operationId: body.operationId, status: response.status, ok: response.ok,
    contentType: response.headers.get('content-type'),
  });
  if (!response.ok) { await jsonResponse(response); return; }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    log.error('client', `${label}: response was not an event stream`, { operationId: body.operationId });
    await response.body?.cancel();
    throw new ApiError('The local server did not return a generation stream.');
  }
  let frames = 0;
  try {
    for await (const frame of readSse(response.body, signal, { label })) {
      if (signal.aborted) {
        log.warn('client', `${label}: signal aborted while reading`, { operationId: body.operationId, frames });
        return;
      }
      if (!frame.data.trim()) continue;
      const event = parseGenerationEvent(frame.data);
      if (event.operationId !== body.operationId) throw new ApiError('The stream belongs to a different operation.');
      frames++;
      if (event.type !== 'artifact-delta') {
        log.info('client', `${label}: event`, { operationId: body.operationId, type: event.type, ...(event.type === 'done' ? { status: event.status } : {}) });
      }
      yield event;
    }
    log.info('client', `${label}: stream consumed`, { operationId: body.operationId, frames, signalAborted: signal.aborted });
  } catch (error) {
    log.error('client', `${label}: stream read failed`, { operationId: body.operationId, frames, error, signalAborted: signal.aborted });
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'The local request timed out. Nothing was retried automatically.';
    if (error.name === 'AbortError') return 'The request was cancelled.';
    if (error instanceof TypeError) return 'Cannot reach the local server. Check that UIHive is running, then try again.';
    return error.message;
  }
  return 'The request could not be completed. Nothing was retried automatically.';
}
