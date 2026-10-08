import { useEffect, useRef, useState } from 'react';
import { log } from '../shared/diagnostics';
import { stripOuterFences } from '../shared/stream';
import { LIMITS } from '../shared/types';
import type {
  Artifact, ArtifactStatus, GenerationEvent, GenerationRequest, IdeasRequest, Session, TraceEntry, VariationsRequest,
} from '../shared/types';
import { cancelOperation, errorMessage, generationEvents } from './api';
import { SEED_PROMPTS } from './constants';

type Kind = 'generate' | 'variations' | 'ideas';
type Terminal = 'complete' | 'incomplete' | 'error' | 'cancelled';

export interface ActiveOperation {
  operationId: string;
  kind: Kind;
  sessionId?: string;
  stopping: boolean;
}

export interface VariationState {
  operationId: string;
  sessionId: string;
  sourceArtifactId: string;
  sourceName: string;
  artifacts: Artifact[];
  status: ArtifactStatus;
  warnings: string[];
  error?: string;
}

interface Operation extends ActiveOperation {
  token: string;
  controller: AbortController;
  artifactIds: string[];
  html: Map<string, string>;
  finished: Set<string>;
  received: number;
  total: number;
  terminal: boolean;
  error?: string;
  readerDone: Promise<void>;
  cancelRequest?: Promise<void>;
}

function pending(artifact: Artifact): boolean {
  return artifact.status === 'queued' || artifact.status === 'streaming';
}

export function useGeneration(token: string | null, enabled: boolean) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<ActiveOperation | null>(null);
  const [variations, setVariations] = useState<VariationState | null>(null);
  const [ideas, setIdeas] = useState<string[]>(SEED_PROMPTS);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<Operation | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const op = operation.current;
      if (op) {
        op.stopping = true;
        op.controller.abort();
        op.cancelRequest ??= cancelOperation(op.token, op.operationId);
        void op.cancelRequest.catch(() => undefined);
      }
    };
  }, []);

  function patchArtifact(op: Operation, artifactId: string, patch: Partial<Artifact>) {
    setSessions((current) => current.map((session) => session.id !== op.sessionId ? session : {
      ...session,
      artifacts: session.artifacts.map((artifact) => artifact.id === artifactId ? { ...artifact, ...patch } : artifact),
    }));
  }

  function finishPending(op: Operation, status: Exclude<Terminal, 'complete'>, message: string) {
    if (!mounted.current) return;
    if (op.kind === 'generate') {
      setSessions((current) => current.map((session) => session.id !== op.sessionId ? session : {
        ...session,
        artifacts: session.artifacts.map((artifact) => op.artifactIds.includes(artifact.id) && pending(artifact)
          ? { ...artifact, html: stripOuterFences(artifact.html), status, error: message } : artifact),
      }));
    } else if (op.kind === 'variations') {
      setVariations((current) => current?.operationId === op.operationId
        ? { ...current, status, error: message } : current);
    }
  }

  function requestCancel(op: Operation) {
    op.cancelRequest ??= cancelOperation(op.token, op.operationId);
    // Attach immediately; the reader may still be unwinding when the request rejects.
    void op.cancelRequest.catch(() => undefined);
  }

  function stop(): Promise<void> {
    const op = operation.current;
    if (!op || op.terminal || op.stopping) return op?.readerDone ?? Promise.resolve();
    op.stopping = true;
    log.warn('client', 'user requested stop', { operationId: op.operationId, kind: op.kind });
    setActive({ operationId: op.operationId, kind: op.kind, sessionId: op.sessionId, stopping: true });
    finishPending(op, 'cancelled', 'Stopped. Partial source is preserved, but this design is not complete.');
    op.controller.abort();
    requestCancel(op);
    return op.readerDone;
  }

  function begin(kind: Kind, sessionId?: string, artifactIds: string[] = []): Operation | null {
    if (operation.current) {
      log.warn('client', 'begin refused: another operation is active', { kind, activeOperationId: operation.current.operationId });
      return null;
    }
    if (!enabled || !token) {
      log.warn('client', 'begin refused: connection is not ready', { kind, enabled, hasToken: !!token });
      setError('Save a usable connection in Connection settings before making a request.');
      return null;
    }
    const op: Operation = {
      operationId: crypto.randomUUID(), kind, sessionId, stopping: false, token,
      artifactIds, controller: new AbortController(), html: new Map(), finished: new Set(),
      received: 0, total: 0, terminal: false, readerDone: Promise.resolve(),
    };
    operation.current = op;
    log.info('client', 'begin operation', { operationId: op.operationId, kind, sessionId: sessionId ?? null, artifactIds });
    setActive({ operationId: op.operationId, kind, sessionId, stopping: false });
    setError(null);
    return op;
  }

  function storeHtml(op: Operation, artifactId: string, html: string) {
    const total = op.total + html.length - (op.html.get(artifactId)?.length ?? 0);
    if (html.length > LIMITS.html || total > LIMITS.totalOutput) {
      throw new Error('Generated output exceeded the safety limit. Existing source has been preserved.');
    }
    op.total = total;
    op.html.set(artifactId, html);
  }

  function accept(op: Operation, event: GenerationEvent) {
    if ('sessionId' in event && event.sessionId !== undefined && event.sessionId !== op.sessionId) {
      throw new Error('The stream referenced a different design deck.');
    }
    if ('artifactId' in event && event.artifactId !== undefined && !op.artifactIds.includes(event.artifactId)) {
      throw new Error('The stream referenced an unexpected design.');
    }
    switch (event.type) {
      case 'plan': {
        if (op.kind !== 'generate') throw new Error('An unexpected design plan was received.');
        setSessions((current) => current.map((session) => session.id !== op.sessionId ? session : {
          ...session,
          artifacts: session.artifacts.map((artifact) => {
            const index = op.artifactIds.indexOf(artifact.id);
            return index < 0 ? artifact : { ...artifact, styleName: event.names[index] };
          }),
        }));
        break;
      }
      case 'trace': {
        setTrace((current) => {
          const next = [...current, event.entry];
          return next.length > 400 ? next.slice(next.length - 400) : next;
        });
        break;
      }
      case 'artifact-delta':
      case 'artifact-done':
      case 'artifact-error': {
        if (op.kind !== 'generate' || op.finished.has(event.artifactId)) {
          throw new Error('The stream sent output for a design that was already finished.');
        }
        if (event.type === 'artifact-delta') {
          const html = (op.html.get(event.artifactId) ?? '') + event.delta;
          storeHtml(op, event.artifactId, html);
          patchArtifact(op, event.artifactId, { html, status: 'streaming' });
        } else if (event.type === 'artifact-done') {
          const html = stripOuterFences(event.html);
          if (!html.trim()) {
            patchArtifact(op, event.artifactId, { status: 'error', error: 'The provider returned an empty design.' });
          } else {
            storeHtml(op, event.artifactId, html);
            patchArtifact(op, event.artifactId, { html, status: event.status ?? 'complete', error: undefined });
          }
          op.finished.add(event.artifactId);
        } else {
          patchArtifact(op, event.artifactId, {
            html: stripOuterFences(op.html.get(event.artifactId) ?? ''), status: event.status, error: event.message,
          });
          op.finished.add(event.artifactId);
        }
        break;
      }
      case 'variation': {
        if (op.kind !== 'variations' || op.received >= 3 || op.finished.has(event.artifact.id) ||
          op.artifactIds.includes(event.artifact.id) || event.artifact.status !== 'complete') {
          throw new Error('The stream returned an invalid or duplicate variation.');
        }
        const html = stripOuterFences(event.artifact.html);
        if (!html.trim()) throw new Error('The provider returned an empty variation.');
        storeHtml(op, event.artifact.id, html);
        op.finished.add(event.artifact.id);
        op.received++;
        setVariations((current) => current?.operationId === op.operationId
          ? { ...current, artifacts: [...current.artifacts, { ...event.artifact, html }] } : current);
        break;
      }
      case 'ideas': {
        if (op.kind !== 'ideas') throw new Error('Unexpected prompt ideas were received.');
        op.received += event.ideas.length;
        setIdeas((current) => {
          const seen = new Set<string>();
          return [...current, ...event.ideas.map((idea) => idea.trim())].filter((idea) => {
            const key = idea.toLowerCase().replace(/\s+/g, ' ');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 60);
        });
        break;
      }
      case 'warning': {
        log.warn('client', 'server warning event', { operationId: op.operationId, kind: op.kind, message: event.message });
        if (op.kind === 'variations') {
          setVariations((current) => current?.operationId === op.operationId
            ? { ...current, warnings: [...new Set([...current.warnings, event.message])] } : current);
        } else if (op.sessionId) {
          setSessions((current) => current.map((session) => session.id !== op.sessionId ? session
            : { ...session, warnings: [...new Set([...session.warnings, event.message])] }));
        } else {
          setError(event.message);
        }
        break;
      }
      case 'error':
        log.error('client', 'server operation error event', { operationId: op.operationId, message: event.message });
        op.error = event.message;
        setError(event.message);
        break;
      case 'done': {
        op.terminal = true;
        let status = event.status;
        const missing = op.kind === 'generate' ? op.finished.size !== 3
          : op.kind === 'variations' ? op.received !== 3 : op.received === 0;
        if (status === 'complete' && (missing || op.error)) {
          status = 'incomplete';
          op.error ??= 'The stream ended without confirming all expected results.';
        }
        const summary = {
          operationId: op.operationId, kind: op.kind, eventStatus: event.status, finalStatus: status,
          finishedArtifacts: op.finished.size, receivedVariationsOrIdeas: op.received, missing,
          opError: op.error ?? null, controllerAborted: op.controller.signal.aborted,
        };
        if (status === 'complete') log.info('client', 'done event received', summary);
        else log.warn('client', 'done event received', summary);
        if (status !== 'complete') {
          const message = op.error ?? (status === 'cancelled' ? 'The operation was cancelled. Partial results are preserved.'
            : 'The operation did not finish successfully. Available results are preserved.');
          finishPending(op, status, message);
          if (status !== 'cancelled') setError(message);
        } else if (op.kind === 'variations') {
          setVariations((current) => current?.operationId === op.operationId
            ? { ...current, status: 'complete' } : current);
        }
        break;
      }
    }
  }

  async function run(op: Operation, body: GenerationRequest | VariationsRequest | IdeasRequest) {
    log.info('client', 'run loop start', { operationId: op.operationId, kind: op.kind });
    try {
      for await (const event of generationEvents(op.kind, op.token, body, op.controller.signal)) {
        if (!mounted.current || op.controller.signal.aborted || operation.current !== op) {
          log.warn('client', 'run loop break', {
            operationId: op.operationId, mounted: mounted.current, aborted: op.controller.signal.aborted,
            currentIsThisOp: operation.current === op, lastEventType: event.type,
          });
          break;
        }
        accept(op, event);
        if (event.type === 'done') break;
      }
      if (!op.terminal && !op.controller.signal.aborted) {
        log.error('client', 'stream ended without a final status', { operationId: op.operationId, kind: op.kind, totalChars: op.total });
        throw new Error('The stream ended without a final status. Partial output is incomplete; nothing was retried.');
      }
    } catch (cause) {
      if (!op.controller.signal.aborted && mounted.current && operation.current === op) {
        const message = errorMessage(cause);
        log.error('client', 'run failed; marking pending output', {
          operationId: op.operationId, kind: op.kind, message, cause, totalChars: op.total,
          finishedArtifacts: op.finished.size, opError: op.error ?? null,
        });
        setError(op.error ? `${op.error} ${message}` : message);
        finishPending(op, op.total > 0 ? 'incomplete' : 'error', message);
        op.stopping = true;
        setActive({ operationId: op.operationId, kind: op.kind, sessionId: op.sessionId, stopping: true });
        op.controller.abort();
        requestCancel(op);
      } else {
        log.warn('client', 'run caught an error but state no longer owns it', {
          operationId: op.operationId, aborted: op.controller.signal.aborted, mounted: mounted.current,
          currentIsThisOp: operation.current === op, error: cause,
        });
      }
    } finally {
      // Do not unlock a new paid operation before both reader and server cancellation settle.
      if (op.cancelRequest) {
        try { await op.cancelRequest; } catch (cause) {
          log.warn('client', 'server cancellation was not confirmed', { operationId: op.operationId, error: cause });
          if (mounted.current && operation.current === op) {
            setError(`Local reading stopped, but server cancellation could not be confirmed. ${errorMessage(cause)} The server may still be releasing this operation.`);
          }
        }
      }
      if (operation.current === op) {
        operation.current = null;
        log.info('client', 'operation unlocked', { operationId: op.operationId, kind: op.kind });
        if (mounted.current) setActive(null);
      }
    }
  }

  function generate(prompt: string): string | null {
    const brief = prompt.trim();
    if (!brief || brief.length > LIMITS.prompt) {
      setError(`Enter a design prompt of 1 to ${LIMITS.prompt.toLocaleString()} characters.`);
      return null;
    }
    const sessionId = crypto.randomUUID();
    const artifactIds: [string, string, string] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const op = begin('generate', sessionId, artifactIds);
    if (!op) return null;
    setSessions((current) => [...current, {
      id: sessionId, prompt: brief, timestamp: Date.now(), warnings: [],
      artifacts: artifactIds.map((id, index) => ({ id, styleName: `Direction ${String(index + 1).padStart(2, '0')}`, html: '', status: 'queued' })),
    }]);
    op.readerDone = run(op, { operationId: op.operationId, sessionId, artifactIds, prompt: brief });
    return sessionId;
  }

  function explore(session: Session, artifact: Artifact): boolean {
    if (artifact.status !== 'complete' || !artifact.html.trim()) return false;
    const op = begin('variations', session.id, session.artifacts.map((item) => item.id));
    if (!op) return false;
    setVariations({
      operationId: op.operationId, sessionId: session.id, sourceArtifactId: artifact.id,
      sourceName: artifact.styleName, artifacts: [], status: 'streaming', warnings: [],
    });
    op.readerDone = run(op, {
      operationId: op.operationId, sessionId: session.id, artifactId: artifact.id,
      prompt: session.prompt, html: artifact.html,
    });
    return true;
  }

  function closeVariations() {
    if (operation.current?.kind === 'variations') void stop();
    setVariations(null);
  }

  function applyVariation(artifactId: string): { sessionId: string; artifactId: string } | null {
    const artifact = variations?.artifacts.find((item) => item.id === artifactId);
    if (!variations || !artifact || artifact.status !== 'complete') return null;
    const sessionId = variations.sessionId;
    setSessions((current) => current.map((session) => session.id !== sessionId || session.artifacts.some((item) => item.id === artifact.id)
      ? session : { ...session, artifacts: [...session.artifacts, { ...artifact }] }));
    closeVariations();
    return { sessionId, artifactId: artifact.id };
  }

  function refreshIdeas() {
    const op = begin('ideas');
    if (op) op.readerDone = run(op, { operationId: op.operationId });
  }

  return {
    sessions, active, variations, ideas, error, trace, generate, stop, explore,
    closeVariations, applyVariation, refreshIdeas, dismissError: () => setError(null),
    clearTrace: () => setTrace([]),
  };
}
