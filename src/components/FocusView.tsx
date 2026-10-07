import { useState } from 'react';
import type { Artifact, Session } from '../../shared/types';
import type { ActiveOperation } from '../useGeneration';
import { ArtifactPreview, ArtifactStatusBadge } from './ArtifactPreview';
import { Icon } from './Icon';
import { isTypingTarget, Modal } from './Modal';

interface Props {
  session: Session;
  artifact: Artifact;
  deckNumber: number;
  active: ActiveOperation | null;
  canGenerate: boolean;
  onClose: () => void;
  onSource: () => void;
  onExplore: () => void;
  onMove: (offset: number) => void;
  onStop: () => void;
}

export function FocusView({ session, artifact, deckNumber, active, canGenerate, onClose, onSource, onExplore, onMove, onStop }: Props) {
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const index = session.artifacts.findIndex((item) => item.id === artifact.id);
  const canPrevious = index > 0;
  const canNext = index < session.artifacts.length - 1;

  return <Modal title={artifact.styleName} eyebrow={`DECK ${String(deckNumber).padStart(2, '0')} / DIRECTION ${String(index + 1).padStart(2, '0')}`}
    variant="focus" closeLabel="Grid View" onClose={onClose}
    headerActions={active && <button type="button" className="button button-stop" aria-label="Stop" disabled={active.stopping} onClick={onStop}><Icon name="stop" />{active.stopping ? 'Stopping...' : 'Stop'}</button>}
    onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft' && canPrevious) { event.preventDefault(); onMove(-1); }
      if (event.key === 'ArrowRight' && canNext) { event.preventDefault(); onMove(1); }
    }}>
    <div className="focus-toolbar">
      <div className="focus-tools" role="group" aria-label="Design actions">
        <button className="button button-secondary" type="button" disabled={!canGenerate || artifact.status !== 'complete'}
          title="Request three variations. Provider charges may apply." onClick={onExplore}><Icon name="sparkles" />Variations</button>
        <button className="button button-subtle" type="button" disabled={!artifact.html} onClick={onSource}><Icon name="code" />Source</button>
      </div>
      <div className="viewport-toggle" role="group" aria-label="Preview viewport">
        <button className="icon-button" type="button" aria-label="Desktop preview" aria-pressed={viewport === 'desktop'} title="Desktop preview" onClick={() => setViewport('desktop')}><Icon name="desktop" /></button>
        <button className="icon-button" type="button" aria-label="Mobile preview" aria-pressed={viewport === 'mobile'} title="Mobile preview" onClick={() => setViewport('mobile')}><Icon name="mobile" /></button>
      </div>
      <div className="focus-status"><ArtifactStatusBadge status={artifact.status} /><span>{artifact.status === 'complete' ? 'Interactive preview' : 'Preview only'}</span></div>
    </div>
    {artifact.error && <div className="focus-error notice notice-warning"><Icon name="alert" /><p>{artifact.error}</p></div>}
    <div className={`focus-stage viewport-${viewport}`}>
      <div className="focus-preview-shell"><ArtifactPreview key={artifact.id} artifact={artifact} interactive onEscape={onClose} /></div>
    </div>
    <footer className="focus-footer">
      <p><Icon name="shield" />Sandboxed. External resources blocked.</p>
      <nav className="focus-navigation" aria-label="Design navigation">
        <button className="icon-button" type="button" disabled={!canPrevious} aria-label="Previous design" title="Previous design" onClick={() => onMove(-1)}><Icon name="arrow-left" /></button>
        <span>{String(index + 1).padStart(2, '0')}<i>/</i>{String(session.artifacts.length).padStart(2, '0')}</span>
        <button className="icon-button" type="button" disabled={!canNext} aria-label="Next design" title="Next design" onClick={() => onMove(1)}><Icon name="arrow-right" /></button>
      </nav>
      <span className="focus-key-hint">Arrow keys to browse <i /> Esc for grid</span>
    </footer>
  </Modal>;
}
