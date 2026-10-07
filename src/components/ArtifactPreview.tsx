import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { Artifact, ArtifactStatus } from '../../shared/types';
import { extractHtml } from '../../shared/stream';
import { PREVIEW_CSP } from '../constants';
import { Icon } from './Icon';
import { isInTopDialog } from './Modal';

export const STATUS_LABELS: Record<ArtifactStatus, string> = {
  queued: 'Queued', streaming: 'Writing', complete: 'Ready', incomplete: 'Incomplete', error: 'Error', cancelled: 'Cancelled',
};

export function previewDocument(html: string): string {
  // This policy must be parsed before any untrusted element, script, or subresource.
  const escapeBridge = '<script>window.addEventListener("keydown",function(event){if(event.key==="Escape"&&event.isTrusted){event.preventDefault();event.stopPropagation();window.parent.postMessage({type:"uihive:escape-preview"},"*")}},true);</script>';
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>body{margin:0}</style>${escapeBridge}${extractHtml(html)}`;
}

export function ArtifactPreview({ artifact, interactive = false, onEscape }: { artifact: Artifact; interactive?: boolean; onEscape?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(artifact.html);
  const timer = useRef<number | null>(null);
  const lastFlush = useRef(0);
  const [html, setHtml] = useState(artifact.html);
  const [size, setSize] = useState({ width: 1100, height: 800 });
  const writing = artifact.status === 'streaming' || artifact.status === 'queued';
  const canInteract = interactive && artifact.status === 'complete';
  const escapeEnabled = canInteract && !!onEscape;
  const closePreview = useEffectEvent(() => onEscape?.());

  useEffect(() => {
    if (!escapeEnabled) return;
    function receive(event: MessageEvent) {
      // The only accepted message is Escape from this opaque, topmost preview.
      // Never accept data, navigation destinations, or API commands from a frame.
      if (frame.current && isInTopDialog(frame.current) && event.source === frame.current.contentWindow &&
        event.origin === 'null' && event.data?.type === 'uihive:escape-preview') closePreview();
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [escapeEnabled]);

  useEffect(() => {
    latest.current = artifact.html;
    if (!writing) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      lastFlush.current = performance.now();
      setHtml(artifact.html);
    } else if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        setHtml(latest.current);
        lastFlush.current = performance.now();
        timer.current = null;
      }, Math.max(0, 220 - (performance.now() - lastFlush.current)));
    }
  }, [artifact.html, writing]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!container.current || interactive) return;
    const element = container.current;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [interactive]);

  return <div ref={container} className={`preview-surface ${interactive ? 'preview-full' : 'preview-thumbnail'}`}>
    {html.trim() ? <iframe ref={frame}
      title={`${artifact.styleName} preview`} srcDoc={previewDocument(html)} sandbox="allow-scripts"
      referrerPolicy="no-referrer" tabIndex={canInteract ? 0 : -1} aria-hidden={!canInteract} inert={!canInteract}
      className={`preview-frame ${canInteract ? 'preview-interactive' : ''}`}
      style={interactive ? undefined : {
        width: 1100, height: Math.max(1, size.height * 1100 / size.width), transform: `scale(${size.width / 1100})`,
      }}
    /> : <div className={`preview-empty ${writing ? 'is-writing' : ''}`}>
      <div className="preview-empty-mark"><Icon name={writing ? 'sparkles' : 'code'} /></div>
      <p>{artifact.status === 'queued' ? 'Finding a direction' : writing ? 'The first lines are on their way'
        : artifact.status === 'cancelled' ? 'A pause, not a finished design' : 'No preview to display'}</p>
      <span>{writing ? 'A little room for possibility.' : 'See the status below for details.'}</span>
      {writing && <div className="writing-track" aria-hidden="true"><i /></div>}
    </div>}
    {writing && html.trim() && <div className="stream-readout" aria-hidden="true">
      <span><i className="status-dot is-live" /> LIVE SOURCE</span>
      <pre>{artifact.html.slice(-260)}</pre>
    </div>}
  </div>;
}

export function ArtifactStatusBadge({ status }: { status: ArtifactStatus }) {
  return <span className={`status-badge status-${status}`}><i className="status-dot" />{STATUS_LABELS[status]}</span>;
}

export function ArtifactCard({ artifact, index, onFocus }: { artifact: Artifact; index: number; onFocus: () => void }) {
  return <article className={`artifact-card artifact-${artifact.status}`} aria-label={`${artifact.styleName}, ${STATUS_LABELS[artifact.status]}`}>
    <header className="artifact-card-header">
      <span className="artifact-index">{String(index + 1).padStart(2, '0')}</span>
      <h3 title={artifact.styleName}>{artifact.styleName}</h3>
      <ArtifactStatusBadge status={artifact.status} />
    </header>
    <div className="artifact-preview-wrap">
      <ArtifactPreview artifact={artifact} />
      <button className="preview-focus-button" type="button" onClick={onFocus} aria-label={`Focus ${artifact.styleName}`}>
        <span className="preview-focus-chip"><Icon name="expand" /><span>Focus preview</span></span>
      </button>
    </div>
    {artifact.error && <p className="artifact-error"><Icon name="alert" />{artifact.error}</p>}
    <footer className="artifact-card-footer">
      <span>HTML <i /> CSS <i /> JS</span>
      <span>{artifact.html ? `${(artifact.html.length / 1024).toFixed(1)} KB` : 'Awaiting output'}<Icon name="arrow-right" /></span>
    </footer>
  </article>;
}
