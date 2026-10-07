import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { stripOuterFences } from '../../shared/stream';
import type { Artifact } from '../../shared/types';
import { ArtifactStatusBadge } from './ArtifactPreview';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function exportFilename(artifact: Artifact): string {
  const slug = artifact.styleName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '') || 'design';
  return `uihive-${slug}${artifact.status === 'complete' ? '' : '-incomplete'}.html`;
}

export function sourceForExport(artifact: Artifact): string {
  const warning = '<!-- UNTRUSTED GENERATED HTML. Inspect before opening. Outside UIHive, this code is not protected by the preview sandbox and may access external resources. -->\n';
  const incomplete = artifact.status === 'complete' ? ''
    : `<!-- INCOMPLETE OUTPUT (${artifact.status}). This source was not confirmed as a finished design. -->\n`;
  return warning + incomplete + stripOuterFences(artifact.html);
}

export function SourceDrawer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const code = useDeferredValue(sourceForExport(artifact));
  const codeRef = useRef<HTMLElement>(null);
  const downloads = useRef(new Map<string, number>());
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const incomplete = artifact.status !== 'complete';

  useEffect(() => {
    const urls = downloads.current;
    return () => urls.forEach((timer, url) => { window.clearTimeout(timer); URL.revokeObjectURL(url); });
  }, []);

  async function copy() {
    setCopying(true);
    setMessage(null);
    try {
      await navigator.clipboard.writeText(sourceForExport(artifact));
      setMessage({ error: false, text: incomplete ? 'Incomplete source copied with its warning.' : 'Source copied as plain text, including its untrusted-code warning.' });
    } catch {
      if (codeRef.current) {
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setMessage({ error: true, text: 'Clipboard access was blocked. The displayed source is selected; use your system copy shortcut.' });
    } finally { setCopying(false); }
  }

  function download() {
    setMessage(null);
    let url: string | undefined;
    try {
      const blob = new Blob([sourceForExport(artifact)], { type: 'text/html;charset=utf-8' });
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(artifact);
      document.body.append(link);
      link.click();
      link.remove();
      const objectUrl = url;
      const timer = window.setTimeout(() => { URL.revokeObjectURL(objectUrl); downloads.current.delete(objectUrl); }, 1000);
      downloads.current.set(url, timer);
      setMessage({ error: false, text: `${incomplete ? 'Incomplete HTML' : 'HTML'} exported. Inspect the untrusted code before opening it.` });
    } catch {
      if (url) URL.revokeObjectURL(url);
      setMessage({ error: true, text: 'The HTML download could not be started. You can still copy the source.' });
    }
  }

  return <Modal title="Source" eyebrow="UNDER THE SURFACE" onClose={onClose} className="source-modal"
    description="Self-contained HTML, CSS, and JavaScript. Yours to inspect and keep.">
    <div className="drawer-body source-body">
      <div className="source-file-heading"><div><Icon name="code" /><strong>{artifact.styleName}</strong></div><ArtifactStatusBadge status={artifact.status} /></div>
      {incomplete && <div className="notice notice-warning"><Icon name="alert" /><p><strong>Incomplete source.</strong> This design is {artifact.status}. Copies and exports are explicitly labelled incomplete.</p></div>}
      <div className="source-actions">
        <button type="button" className="button button-secondary" aria-label="Copy source" disabled={!artifact.html || copying} onClick={() => void copy()}><Icon name="copy" />{copying ? 'Copying...' : 'Copy source'}</button>
        <button type="button" className="button button-primary" aria-label="Export HTML" disabled={!artifact.html} onClick={download}><Icon name="download" />Export HTML</button>
      </div>
      {message && <p className={`inline-feedback ${message.error ? 'text-warning' : 'text-success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      <div className="code-panel">
        <div className="code-panel-header"><span>{exportFilename(artifact)}</span><span>{artifact.html.length.toLocaleString()} characters</span></div>
        <pre className="source-code" tabIndex={0} aria-label={`${artifact.styleName} HTML source`}><code ref={codeRef}>{code || 'No source has arrived yet.'}</code></pre>
      </div>
      <aside className="security-note"><Icon name="shield" /><div><strong>Read it before you run it.</strong>
        <p>Source is displayed as escaped text. Previews use an opaque-origin sandbox and block external resources; sandboxing cannot prevent resource exhaustion or all iframe navigation.</p>
        <p>Downloaded HTML is untrusted. Opening it outside UIHive removes those protections. Exports include a warning. History is ephemeral, so export anything you want to keep before reloading.</p>
      </div></aside>
    </div>
  </Modal>;
}
