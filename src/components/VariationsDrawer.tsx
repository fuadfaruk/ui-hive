import type { ActiveOperation, VariationState } from '../useGeneration';
import { ArtifactPreview } from './ArtifactPreview';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface Props {
  variations: VariationState;
  active: ActiveOperation | null;
  onClose: () => void;
  onApply: (id: string) => void;
  onStop: () => void;
}

export function VariationsDrawer({ variations, active, onClose, onApply, onStop }: Props) {
  const writing = variations.status === 'streaming';
  const isActive = active?.operationId === variations.operationId;
  return <Modal title="Variations" eyebrow="FOLLOW ANOTHER THREAD" onClose={onClose} className="variations-modal"
    description="Three new interpretations. Keep the original, and add the one that feels right.">
    <div className="drawer-body variations-body">
      <div className="variation-origin"><Icon name="sparkles" /><div><span>EXPLORING FROM</span><strong>{variations.sourceName}</strong></div></div>
      <div className="variation-progress" role="status"><span>{writing ? 'Exploring possibilities' : variations.status === 'complete' ? 'Three new directions, ready to explore' : 'Available results are preserved'}</span><span>{variations.artifacts.length} / 3</span></div>
      {variations.error && <div className="notice notice-warning" role="alert"><Icon name="alert" /><p>{variations.error}</p></div>}
      {variations.warnings.map((warning) => <div className="notice notice-warning" key={warning}><Icon name="alert" /><p>{warning}</p></div>)}
      <div className="variation-list">
        {variations.artifacts.map((artifact, index) => <article className="variation-card" key={artifact.id}>
          <div className="variation-preview"><ArtifactPreview artifact={artifact} /></div>
          <div className="variation-card-footer"><div><span className="eyebrow">VARIATION {String(index + 1).padStart(2, '0')}</span><h3>{artifact.styleName}</h3></div>
            <button className="button button-primary" type="button" disabled={!!active?.stopping} aria-label={`Apply ${artifact.styleName}`} onClick={() => onApply(artifact.id)}>Apply<Icon name="plus" /></button>
          </div>
        </article>)}
        {writing && Array.from({ length: Math.max(0, 3 - variations.artifacts.length) }, (_, index) => <div className="variation-waiting" key={index}>
          <span className="variation-waiting-index">{String(variations.artifacts.length + index + 1).padStart(2, '0')}</span>
          <div><span className="spinner" /><p>A different perspective is taking shape.</p></div>
        </div>)}
      </div>
      {isActive && <button className="button button-stop variation-stop" type="button" aria-label="Stop" disabled={active.stopping} onClick={onStop}><Icon name="stop" />{active.stopping ? 'Stopping...' : 'Stop'}</button>}
      <p className="drawer-footnote">Applying a variation adds it to its original deck. Closing or applying cancels any remaining work. Valid results already received stay usable.</p>
    </div>
  </Modal>;
}
