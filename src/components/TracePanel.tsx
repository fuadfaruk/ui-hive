import { useEffect, useRef, useState } from 'react';
import type { TraceEntry } from '../../shared/types';
import { Icon } from './Icon';

const DIRECTION_LABELS = { in: 'IN', out: 'OUT' } as const;
// Rendering the full 16 KB server clip for hundreds of entries would build a very
// large DOM, so the panel shows a generous head and reports the captured length.
const MAX_RENDER_CHARS = 4000;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function TracePanel({ entries, tracing, onClear, onClose }: {
  entries: TraceEntry[];
  tracing: boolean;
  onClear: () => void;
  onClose: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    if (!follow) return;
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, follow]);

  function onScroll() {
    const element = scroll.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
  }

  async function copyEntry(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied((current) => current === index ? null : current), 1500);
    } catch {
      setCopied(null);
    }
  }

  return <aside className="trace-panel" aria-label="Raw provider inspector">
    <header className="trace-header">
      <div><p className="eyebrow">RAW I/O</p><h2>Provider inspector</h2></div>
      <div className="trace-header-actions">
        <button className="icon-button" type="button" aria-label="Clear trace" title="Clear trace" disabled={!entries.length} onClick={onClear}><Icon name="refresh" /></button>
        <button className="icon-button" type="button" aria-label="Close provider inspector" title="Close provider inspector" onClick={onClose}><Icon name="close" /></button>
      </div>
    </header>
    <div className="trace-meta">
      <span><i className={`status-dot ${tracing ? 'is-live' : ''}`} />{tracing ? 'TRACING' : 'TRACE OFF'}</span>
      <span>{entries.length} ENTRIES</span>
      <label className="trace-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow</label>
    </div>
    {!tracing && <p className="trace-hint">Raw tracing runs in development or with UI_MAKER_TRACE=1. Production requests stay silent.</p>}
    <div className="trace-scroll" ref={scroll} onScroll={onScroll}>
      {entries.length === 0
        ? <p className="trace-empty">{tracing ? 'Waiting for the next operation.' : 'No trace captured.'}</p>
        : entries.map((entry, index) => {
          const shown = entry.text.slice(0, MAX_RENDER_CHARS);
          return <article className={`trace-entry trace-entry-${entry.dir}`} key={`${entry.at}-${index}`}>
            <header className="trace-entry-head">
              <span className={`trace-dir trace-dir-${entry.dir}`}>{DIRECTION_LABELS[entry.dir]}</span>
              <span className="trace-label" title={entry.label}>{entry.label}</span>
              <span className="trace-channel">{entry.channel}</span>
              <time dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
              <button className="trace-copy" type="button" aria-label="Copy this entry" title="Copy this entry" onClick={() => void copyEntry(index, entry.text)}>
                <Icon name={copied === index ? 'check' : 'copy'} />
              </button>
            </header>
            <pre className="trace-text">{shown}</pre>
            {(entry.truncated || shown.length !== entry.text.length) && <p className="trace-truncated">
              {entry.text.length.toLocaleString()} characters captured{entry.truncated ? ', clipped by the server' : ', shown in part'}.
            </p>}
          </article>;
        })}
    </div>
  </aside>;
}
