import { Icon } from './Icon';

export function EmptyStudio({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  return <section className="empty-studio" aria-labelledby="empty-title">
    <div className="studio-intro">
      <p className="eyebrow"><span className="eyebrow-line" />A SMALL STUDIO FOR BIG POSSIBILITIES</p>
      <h1 id="empty-title">One idea.<br />Three <em>directions.</em></h1>
      <p className="intro-description">Turn a thought into something you can see.<br className="desktop-break" /> Compare, explore, and make it your own.</p>
      {!connected && <button className="intro-connect text-button" type="button" onClick={onConnect}>Connect your model to begin<Icon name="arrow-right" /></button>}
    </div>
    <div className="material-studies" aria-label="Material studies, not generated designs">
      <article className="material-study study-glass">
        <header><span>01</span><span>MATERIAL STUDY</span></header>
        <div className="material-art glass-art" aria-hidden="true"><i className="glass-orbit" /><i className="glass-disc" /><i className="glass-window" /></div>
        <footer><div><h2>Soft light</h2><p>Transparency / atmosphere</p></div><span className="material-coordinate">G.01</span></footer>
      </article>
      <article className="material-study study-paper">
        <header><span>02</span><span>MATERIAL STUDY</span></header>
        <div className="material-art paper-art" aria-hidden="true"><i className="paper-sheet paper-back" /><i className="paper-sheet paper-front"><span /></i><i className="paper-rule" /></div>
        <footer><div><h2>Printed matter</h2><p>Texture / quiet structure</p></div><span className="material-coordinate">P.02</span></footer>
      </article>
      <article className="material-study study-wire">
        <header><span>03</span><span>MATERIAL STUDY</span></header>
        <div className="material-art wire-art" aria-hidden="true"><i className="wire-grid" /><i className="wire-plane plane-back" /><i className="wire-plane plane-front" /><i className="wire-point" /></div>
        <footer><div><h2>Precision cut</h2><p>Geometry / deliberate contrast</p></div><span className="material-coordinate">W.03</span></footer>
      </article>
    </div>
    <div className="empty-caption"><span className="tiny-cross" aria-hidden="true">+</span><p>Material studies, not generated designs. Your first prompt starts a fresh deck.</p><span className="tiny-cross" aria-hidden="true">+</span></div>
  </section>;
}
