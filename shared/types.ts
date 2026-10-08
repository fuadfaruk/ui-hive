export type Protocol = 'openai' | 'anthropic';

export interface ConnectionSettings {
  protocol: Protocol;
  apiUrl: string;
  model: string;
  anthropicMaxTokens: number;
  openaiTokenLimit?: {
    field: 'max_tokens' | 'max_completion_tokens';
    value: number;
  };
  firstByteTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

export interface PublicConnection {
  settings: ConnectionSettings | null;
  hasKey: boolean;
  resolvedUrl: string | null;
}

export interface Bootstrap {
  csrfToken: string;
  connection: PublicConnection;
  storageError?: string;
}

export type ArtifactStatus = 'queued' | 'streaming' | 'complete' | 'incomplete' | 'error' | 'cancelled';

export interface Artifact {
  id: string;
  styleName: string;
  html: string;
  status: ArtifactStatus;
  error?: string;
}

export interface Session {
  id: string;
  prompt: string;
  timestamp: number;
  artifacts: Artifact[];
  warnings: string[];
}

export interface GenerationRequest {
  operationId: string;
  sessionId: string;
  prompt: string;
  artifactIds: [string, string, string];
}

export interface VariationsRequest {
  operationId: string;
  sessionId: string;
  artifactId: string;
  prompt: string;
  html: string;
}

export interface IdeasRequest {
  operationId: string;
}

export type TraceDirection = 'in' | 'out';
export type TraceChannel = 'request' | 'response' | 'frame';
export type TracePhase = 'plan' | 'generate' | 'variations' | 'ideas';

export interface TraceEntry {
  at: number;
  dir: TraceDirection;
  channel: TraceChannel;
  phase: TracePhase;
  label: string;
  text: string;
  artifactId?: string;
  truncated?: boolean;
}

export type Trace = (entry: TraceEntry) => void;

type EventBase = { operationId: string };
type ArtifactEvent = EventBase & { sessionId: string; artifactId: string };

export type GenerationEvent =
  | (EventBase & { type: 'plan'; sessionId: string; names: [string, string, string] })
  | (EventBase & { type: 'trace'; entry: TraceEntry })
  | (ArtifactEvent & { type: 'artifact-delta'; delta: string })
  | (ArtifactEvent & { type: 'artifact-done'; html: string; status?: 'complete' | 'incomplete' })
  | (ArtifactEvent & {
      type: 'artifact-error';
      status: 'error' | 'incomplete' | 'cancelled';
      message: string;
    })
  | (EventBase & { type: 'variation'; sessionId: string; artifact: Artifact })
  | (EventBase & { type: 'ideas'; ideas: string[] })
  | (EventBase & { type: 'warning'; message: string; sessionId?: string; artifactId?: string })
  | (EventBase & { type: 'error'; message: string })
  | (EventBase & { type: 'done'; status: 'complete' | 'incomplete' | 'error' | 'cancelled' });

export const LIMITS = {
  prompt: 12000,
  html: 2 * 1024 * 1024,
  sseEvent: 3 * 1024 * 1024,
  variationBuffer: 3 * 1024 * 1024,
  totalOutput: 8 * 1024 * 1024,
  requestBytes: 4 * 1024 * 1024,
  connectMs: 30000,
  // Raw provider text shown in the development inspector. Each entry is clipped to
  // this length so a single trace event can never approach the SSE event limit.
  traceChars: 16 * 1024,
  // Streaming headers must wait for the provider's first upstream token, which is
  // not a TCP connect and can far exceed connectMs. This budget stays below the
  // upstream gateway's ~100s edge timeout so we fail with our own error first.
  streamHeadersMs: 90000,
  inactivityMs: 45000,
} as const;
