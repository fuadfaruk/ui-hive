import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { resolveRequestUrl } from '../shared/connection.js';
import { log } from '../shared/diagnostics.js';
import { ConnectionError, ConnectionService, EncryptedConnectionStore, publicConnection, type CredentialStore } from './connection.js';
import { createSecurity, HttpError, OperationGuard } from './security.js';
import { createProvider, ProviderError } from './providers.js';
import { runGeneration, runIdeas, runVariations, type Emit } from './generation.js';
import { createRunLog, type RunLog } from './runlog.js';
import { LIMITS, type Bootstrap, type GenerationEvent, type GenerationRequest, type IdeasRequest, type Trace, type VariationsRequest } from '../shared/types.js';

function logFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

export interface AppOptions {
  origin: string;
  development?: boolean;
  store?: CredentialStore;
  providerFactory?: typeof createProvider;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new HttpError(400, 'A valid operation, session, or artifact ID is required.');
  return value;
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new HttpError(400, `${label} must be nonempty and at most ${maximum} characters.`);
  }
  return value;
}

export function validateGeneration(body: unknown): GenerationRequest {
  const value = object(body);
  if (!Array.isArray(value.artifactIds) || value.artifactIds.length !== 3 || new Set(value.artifactIds).size !== 3) {
    throw new HttpError(400, 'Exactly three distinct artifact IDs are required.');
  }
  return {
    operationId: id(value.operationId), sessionId: id(value.sessionId),
    prompt: text(value.prompt, LIMITS.prompt, 'Prompt').trim(),
    artifactIds: value.artifactIds.map(id) as [string, string, string],
  };
}

export function validateVariations(body: unknown): VariationsRequest {
  const value = object(body);
  return {
    operationId: id(value.operationId), sessionId: id(value.sessionId), artifactId: id(value.artifactId),
    prompt: text(value.prompt, LIMITS.prompt, 'Prompt').trim(), html: text(value.html, LIMITS.html, 'Source HTML'),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError || error instanceof ConnectionError || error instanceof ProviderError) return error.message;
  return 'The local operation failed. No request was retried. Check the connection and try again explicitly.';
}

function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 15000);
    timer.unref();
    function cleanup() {
      clearTimeout(timer);
      res.off('drain', done);
      res.off('close', fail);
      res.off('error', fail);
    }
    function done() { cleanup(); resolve(); }
    function fail() { cleanup(); reject(new Error('Client disconnected or stopped reading.')); }
    res.once('drain', done);
    res.once('close', fail);
    res.once('error', fail);
    if (res.destroyed) fail();
  });
}

export function createLocalApp(options: AppOptions) {
  const app = express();
  const security = createSecurity(options.origin, options.development);
  const connections = new ConnectionService(options.store ?? new EncryptedConnectionStore());
  const providerFactory = options.providerFactory ?? createProvider;
  const guard = new OperationGuard();
  // The raw provider inspector is a development aid: it is off in production unless
  // UI_MAKER_TRACE is set explicitly. Traced text is still credential-redacted.
  const tracing = options.development === true || /^(?:1|true|yes|on)$/i.test(process.env.UI_MAKER_TRACE ?? '');
  // The persisted run log sits beside the inspector: on by default in development,
  // forced with UI_HIVE_LOGS=1/0, and always off under Vitest so tests never touch disk.
  const inTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
  const logging = inTest ? false : (logFlag(process.env.UI_HIVE_LOGS) ?? options.development === true);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(security.headers);
  app.use('/api', security.mutation);
  app.use('/api', express.json({ limit: LIMITS.requestBytes, strict: true }));

  app.get('/api/bootstrap', async (_req, res) => {
    const result: Bootstrap = { csrfToken: security.token, connection: publicConnection(null) };
    try {
      result.connection = await connections.public();
    } catch (error) {
      result.storageError = errorMessage(error);
    }
    log.server('info', 'server', 'bootstrap served', {
      hasKey: result.connection.hasKey,
      protocol: result.connection.settings?.protocol ?? null,
      model: result.connection.settings?.model ?? null,
      resolvedUrl: result.connection.resolvedUrl,
      storageError: result.storageError ?? null,
    });
    res.json(result);
  });

  async function connectionMutation(req: Request, res: Response, forget: boolean) {
    const operation = guard.acquire(`connection-${randomUUID()}`);
    try {
      object(req.body);
      res.json(forget ? await connections.forget() : await connections.save(req.body));
    } finally {
      operation.finish();
    }
  }
  app.post('/api/connection', (req, res) => connectionMutation(req, res, false));
  app.delete('/api/connection', (req, res) => connectionMutation(req, res, true));

  app.post('/api/connection/test', async (req, res) => {
    const operation = guard.acquire(`test-${randomUUID()}`);
    const disconnect = () => { if (!res.writableEnded) operation.abort(); };
    res.once('close', disconnect);
    try {
      const draft = await connections.prepare(req.body);
      log.server('info', 'server', 'connection test started', { protocol: draft.settings.protocol, model: draft.settings.model });
      await providerFactory(draft).complete({
        system: 'This is an explicit connection test. Reply with the single word OK.',
        user: 'Reply OK.', maxTokens: 32, signal: operation.signal,
      });
      log.server('info', 'server', 'connection test succeeded', { protocol: draft.settings.protocol, model: draft.settings.model });
      res.json({ ok: true, message: 'The configured model responded successfully. Draft settings have not been saved.' });
    } catch (error) {
      log.server('warn', 'server', 'connection test failed', { error });
      throw error;
    } finally {
      res.off('close', disconnect);
      operation.finish();
    }
  });

  async function streamOperation<T extends { operationId: string }>(
    kind: 'generate' | 'variations' | 'ideas',
    request: T,
    res: Response,
    run: (client: ReturnType<typeof createProvider>, input: T, signal: AbortSignal, emit: Emit, trace?: Trace, logger?: RunLog) => Promise<void>,
  ) {
    const operationId = request.operationId;
    const started = Date.now();
    let abortReason: string | undefined;
    const operation = guard.acquire(operationId);
    let logger: RunLog | undefined;
    let doneStatus: Extract<GenerationEvent, { type: 'done' }>['status'] | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTicks = 0;
    let terminal = false;
    let writes = Promise.resolve();
    let eventsEmitted = 0;
    let deltaEvents = 0;
    let drainWaits = 0;
    let drainMs = 0;
    const disconnect = () => {
      abortReason ??= 'http-client-disconnect';
      log.server('warn', 'server', 'response closed by peer', { operationId, writableEnded: res.writableEnded, destroyed: res.destroyed });
      if (!res.writableEnded) operation.abort();
    };
    res.once('close', disconnect);
    log.server('info', 'server', 'operation started', { operationId, kind });
    const emit: Emit = (event: GenerationEvent) => {
      writes = writes.then(async () => {
        if (res.destroyed || res.writableEnded) {
          log.server('warn', 'server', 'emit after client gone', { operationId, type: event.type, destroyed: res.destroyed, writableEnded: res.writableEnded });
          abortReason ??= 'emit-client-gone';
          throw new Error('Client disconnected.');
        }
        if (terminal) return;
        const payload = JSON.stringify(event);
        if (payload.length > LIMITS.sseEvent) throw new Error('Output event exceeded the limit.');
        eventsEmitted++;
        if (event.type === 'artifact-delta') deltaEvents++;
        const quiet = event.type === 'artifact-delta' || event.type === 'trace';
        if (!quiet || (event.type === 'artifact-delta' && (deltaEvents === 1 || deltaEvents % 500 === 0))) {
          log.server('debug', 'server', 'emit event', {
            operationId, type: event.type, payloadBytes: payload.length, eventsEmitted,
            ...(event.type === 'done' ? { status: event.status } : {}),
            ...(event.type === 'artifact-delta' ? { artifactId: event.artifactId, deltaChars: event.delta.length } : {}),
          });
        }
        if (!res.write(`data: ${payload}\n\n`)) {
          drainWaits++;
          const waitStarted = Date.now();
          log.server('debug', 'server', 'waiting for socket drain', { operationId, eventsEmitted, writableLength: res.writableLength });
          await waitForDrain(res);
          drainMs += Date.now() - waitStarted;
        }
        if (event.type === 'done') {
          terminal = true;
          doneStatus = event.status;
        }
      });
      return writes;
    };
    // Fire-and-forget so the provider call is never blocked by inspector delivery.
    const trace: Trace | undefined = tracing
      ? (entry) => { void emit({ type: 'trace', operationId, entry }).catch(() => undefined); }
      : undefined;
    try {
      const snapshot = await connections.snapshot();
      log.server('info', 'server', 'connection snapshot loaded', {
        operationId, protocol: snapshot.settings.protocol, model: snapshot.settings.model,
        hasKey: !!snapshot.key, anthropicMaxTokens: snapshot.settings.anthropicMaxTokens,
      });
      operation.signal.throwIfAborted();
      if (logging) {
        const fields = request as Partial<GenerationRequest & VariationsRequest>;
        logger = createRunLog({ operationId, kind });
        logger.meta({
          protocol: snapshot.settings.protocol,
          model: snapshot.settings.model,
          resolvedUrl: resolveRequestUrl(snapshot.settings.protocol, snapshot.settings.apiUrl),
          ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
          ...(fields.artifactId !== undefined ? { artifactId: fields.artifactId } : {}),
          ...(fields.artifactIds !== undefined ? { artifactIds: fields.artifactIds } : {}),
          ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
          promptChars: fields.prompt?.length ?? 0,
          startedAt: new Date(started).toISOString(),
        });
      }
      // Generation streams artifacts one at a time, so the deadline scales with the
      // per-stream provider budgets instead of assuming three concurrent streams.
      const streams = kind === 'generate' ? 3 : 1;
      const perStream = (snapshot.settings.firstByteTimeoutMs ?? LIMITS.streamHeadersMs) +
        (snapshot.settings.inactivityTimeoutMs ?? LIMITS.inactivityMs);
      const deadlineMs = Math.max(12 * 60 * 1000, streams * perStream + 60_000);
      deadline = setTimeout(() => {
        abortReason ??= 'operation-deadline';
        log.server('warn', 'server', 'operation deadline reached', { operationId, deadlineMs });
        operation.abort();
      }, deadlineMs);
      deadline.unref();
      log.server('info', 'server', 'operation deadline armed', { operationId, deadlineMs, streams });
      const client = providerFactory(snapshot);
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      log.server('info', 'server', 'SSE headers flushed', { operationId, elapsedMs: Date.now() - started });
      heartbeat = setInterval(() => {
        heartbeatTicks++;
        if (!res.destroyed && !res.writableEnded && res.writableLength < 64 * 1024) res.write(': keepalive\n\n');
      }, 15000);
      heartbeat.unref();
      await run(client, request, operation.signal, emit, trace, logger);
      await writes;
      log.server('info', 'server', 'run resolved', { operationId, elapsedMs: Date.now() - started, terminal, eventsEmitted, deltaEvents });
      if (!terminal) {
        log.server('warn', 'server', 'run ended without a terminal done event', { operationId, abortReason });
        await emit({ type: 'error', operationId: request.operationId, message: 'The operation ended without a completion event. Partial output is incomplete.' });
        await emit({ type: 'done', operationId: request.operationId, status: operation.signal.aborted ? 'cancelled' : 'error' });
      }
    } catch (error) {
      log.server('error', 'server', 'operation threw', { operationId, elapsedMs: Date.now() - started, abortReason, signalAborted: operation.signal.aborted, error });
      operation.abort();
      if (!res.headersSent) throw error;
      if (!res.destroyed && !terminal) {
        // Do not expose exception details, request headers, or upstream response bodies.
        writes = writes.catch(() => undefined);
        await emit({ type: 'error', operationId: request.operationId, message: errorMessage(error) }).catch(() => undefined);
        await emit({ type: 'done', operationId: request.operationId, status: 'error' }).catch(() => undefined);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(deadline);
      res.off('close', disconnect);
      operation.finish();
      log.server('info', 'server', 'operation finished', {
        operationId,
        elapsedMs: Date.now() - started,
        abortReason: abortReason ?? 'none',
        signalAborted: operation.signal.aborted,
        terminal,
        eventsEmitted,
        deltaEvents,
        heartbeatTicks,
        drainWaits,
        drainMs,
        headersSent: res.headersSent,
        destroyed: res.destroyed,
        writableEnded: res.writableEnded,
      });
      if (logger) {
        logger.finish({ status: doneStatus ?? (operation.signal.aborted ? 'cancelled' : 'error'), elapsedMs: Date.now() - started });
        await logger.close();
      }
      if (res.headersSent && !res.writableEnded) res.end();
    }
  }

  app.post('/api/generate', (req, res) => streamOperation('generate', validateGeneration(req.body), res, runGeneration));
  app.post('/api/variations', (req, res) => streamOperation('variations', validateVariations(req.body), res, runVariations));
  app.post('/api/ideas', (req, res) => {
    const request: IdeasRequest = { operationId: id(object(req.body).operationId) };
    return streamOperation('ideas', request, res, runIdeas);
  });
  app.post('/api/operations/:id/cancel', async (req, res) => {
    object(req.body);
    const operationId = id(req.params.id);
    log.server('info', 'server', 'explicit cancel requested', { operationId });
    await guard.cancel(operationId);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown local API operation.' }); });

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      log.server('warn', 'server', 'error handler after headers were sent', { error });
      res.end();
      return;
    }
    const status = error instanceof HttpError || error instanceof ConnectionError ? error.statusCode
      : error?.type === 'entity.too.large' ? 413
      : error instanceof SyntaxError ? 400
      : error instanceof ProviderError ? 502 : 500;
    const message = error?.type === 'entity.too.large' ? 'The request exceeds the local size limit.'
      : error instanceof SyntaxError ? 'The request body must be valid JSON.' : errorMessage(error);
    log.server(status >= 500 ? 'error' : 'warn', 'server', 'request rejected', { status, message, error });
    res.status(status).json({ error: message });
  };
  app.use(onError);
  return { app, security, shutdown: () => guard.shutdown() };
}
