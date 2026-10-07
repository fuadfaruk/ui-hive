import { useEffect, useRef, useState } from 'react';
import { log } from '../shared/diagnostics';
import type { PublicConnection } from '../shared/types';
import { errorMessage, getBootstrap } from './api';
import { useGeneration } from './useGeneration';
import { ArtifactCard } from './components/ArtifactPreview';
import { ConnectionSettings } from './components/ConnectionSettings';
import { EmptyStudio } from './components/EmptyStudio';
import { FocusView } from './components/FocusView';
import { Icon } from './components/Icon';
import { isTypingTarget } from './components/Modal';
import { PromptComposer } from './components/PromptComposer';
import { SourceDrawer } from './components/SourceDrawer';
import { TracePanel } from './components/TracePanel';
import { VariationsDrawer } from './components/VariationsDrawer';

type Target = { sessionId: string; artifactId: string };

export default function App() {
  const [connection, setConnection] = useState<PublicConnection>({ settings: null, hasKey: false, resolvedUrl: null });
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Target | null>(null);
  const [source, setSource] = useState<Target | null>(null);
  const [prompt, setPrompt] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const connectionReady = !!token && connection.hasKey && !!connection.settings && !!connection.resolvedUrl && !storageError;
  const generation = useGeneration(token, connectionReady && !connectionBusy);
  const { sessions, active, variations } = generation;
  const selectedIndex = sessions.findIndex((session) => session.id === selectedSessionId);
  const selected = sessions[selectedIndex];
  const focusSession = sessions.find((session) => session.id === focus?.sessionId);
  const focusedArtifact = focusSession?.artifacts.find((artifact) => artifact.id === focus?.artifactId);
  const sourceArtifact = sessions.find((session) => session.id === source?.sessionId)?.artifacts.find((artifact) => artifact.id === source?.artifactId);
  const canGenerate = connectionReady && !connectionBusy && !active;

  useEffect(() => {
    let subscribed = true;
    getBootstrap().then((bootstrap) => {
      if (!subscribed) return;
      log.info('client', 'bootstrap ready', {
        hasKey: bootstrap.connection.hasKey,
        protocol: bootstrap.connection.settings?.protocol ?? null,
        model: bootstrap.connection.settings?.model ?? null,
        resolvedUrl: bootstrap.connection.resolvedUrl,
        storageError: bootstrap.storageError ?? null,
      });
      setToken(bootstrap.csrfToken);
      setConnection(bootstrap.connection);
      setStorageError(bootstrap.storageError ?? null);
    }).catch((error) => {
      log.error('client', 'bootstrap failed', { error });
      if (subscribed) setStartupError(errorMessage(error));
    })
      .finally(() => { if (subscribed) setLoading(false); });
    return () => { subscribed = false; };
  }, []);

  function generate(brief = prompt) {
    const id = generation.generate(brief);
    if (id) { setSelectedSessionId(id); setFocus(null); }
  }

  function moveDeck(offset: number) {
    const next = sessions[selectedIndex + offset];
    if (next) setSelectedSessionId(next.id);
  }

  function moveArtifact(offset: number) {
    if (!focusSession || !focusedArtifact) return;
    const next = focusSession.artifacts[focusSession.artifacts.findIndex((artifact) => artifact.id === focusedArtifact.id) + offset];
    if (next) setFocus({ sessionId: focusSession.id, artifactId: next.id });
  }

  return <div className="studio-shell">
    <div className="studio-background" aria-hidden="true" />
    <a className="skip-link" href="#studio-main">Skip to the studio</a>
    <header className="app-header">
      <a className="brand" href="#studio-main" aria-label="UIHive studio"><span className="brand-mark"><Icon name="bolt" /></span><span>UI<span className="brand-light">Hive</span></span><span className="brand-edition">STUDIO / 01</span></a>
      <div className="header-right">
        <span className="local-indicator"><i className="status-dot" />LOCAL WORKSPACE</span>
        <span className="header-divider" />
        <button className={`button inspector-button ${inspectorOpen ? 'is-open' : ''}`} type="button" aria-label="Raw provider inspector" aria-pressed={inspectorOpen} title="Show raw provider request and response" onClick={() => setInspectorOpen((open) => !open)}>
          <Icon name="code" /><span>Raw I/O</span>
        </button>
        <button className={`button connection-button ${connectionReady ? 'is-configured' : ''}`} type="button" aria-label="Connection settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" /><span>Connection settings</span><i className={`status-dot ${connectionReady ? 'is-connected' : ''}`} />
        </button>
      </div>
    </header>

    {(startupError || storageError) && <div className="startup-notices">
      {startupError && <div className="notice notice-error" role="alert"><Icon name="alert" /><div><strong>The local server could not be loaded.</strong><p>{startupError} Reload this page after the server is available.</p></div><button className="button button-secondary" type="button" onClick={() => window.location.reload()}>Reload studio</button></div>}
      {storageError && <div className="notice notice-error" role="alert"><Icon name="alert" /><div><strong>Saved connection needs attention.</strong><p>{storageError} Open Connection settings to repair or remove it. Generation is disabled until this is resolved.</p></div></div>}
    </div>}

    <div className={`workspace ${inspectorOpen ? 'has-inspector' : ''}`}>
      <aside className="deck-sidebar" aria-label="Deck history">
        <div className="sidebar-heading"><h2>Your decks</h2><span>{String(sessions.length).padStart(2, '0')}</span></div>
        <button className={`new-deck-button ${selectedSessionId === null ? 'is-active' : ''}`} type="button" onClick={() => {
          setSelectedSessionId(null); setPrompt(''); input.current?.focus({ preventScroll: true });
        }}><Icon name="plus" /><span>New prompt</span></button>
        {sessions.length ? <nav className="deck-history" aria-label="Saved decks in this tab"><ol className="deck-list">
          {[...sessions].reverse().map((session) => {
            const number = sessions.indexOf(session) + 1;
            const complete = session.artifacts.filter((artifact) => artifact.status === 'complete').length;
            const working = active?.sessionId === session.id;
            return <li key={session.id}><button className={`deck-button ${selectedSessionId === session.id ? 'is-active' : ''}`} type="button"
              aria-current={selectedSessionId === session.id ? 'true' : undefined} aria-label={`Deck ${number}: ${session.prompt}`} title={session.prompt}
              onClick={() => setSelectedSessionId(session.id)}>
              <span className="deck-number">{String(number).padStart(2, '0')}</span><span className="deck-description"><strong>{session.prompt}</strong><span>{working ? <><i className="status-dot is-live" />{active.stopping ? 'Stopping' : 'In progress'}</> : `${complete} of ${session.artifacts.length} ready`}</span></span>
              <span className="deck-active-mark" aria-hidden="true" />
            </button></li>;
          })}
        </ol></nav> : <div className="history-empty"><div className="empty-deck-mark" aria-hidden="true"><i /><i /><i /></div><h3>A clean slate.</h3><p>Your prompts collect here.<br />Every deck, a new direction.</p><span>YOUR FIRST DECK AWAITS</span></div>}
        <div className="history-lifetime"><Icon name="clock" /><div><strong>Just for this visit.</strong><p>History clears on reload.<br />Export the designs you love.</p></div></div>
      </aside>

      <main id="studio-main" className="workbench" tabIndex={-1} onKeyDown={(event) => {
        if (focus || settingsOpen || source || variations || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
        if (event.key === 'ArrowLeft' && selectedIndex > 0) { event.preventDefault(); moveDeck(-1); }
        if (event.key === 'ArrowRight' && selectedIndex < sessions.length - 1) { event.preventDefault(); moveDeck(1); }
      }}>
        <div className="workbench-heading"><div><span className="studio-status-mark" /><span>{selected ? `DECK ${String(selectedIndex + 1).padStart(2, '0')}` : 'THE STUDIO'}</span><i>/</i><span>{selected ? `${selected.artifacts.length} DIRECTIONS` : 'A PLACE TO START'}</span></div>
          <nav className="deck-navigation" aria-label="Deck navigation"><span>{`${selected ? String(selectedIndex + 1).padStart(2, '0') : '00'} / ${String(sessions.length).padStart(2, '0')}`}</span>
            <button className="icon-button" type="button" aria-label="Previous deck" title="Previous deck" disabled={selectedIndex <= 0} onClick={() => moveDeck(-1)}><Icon name="arrow-left" /></button>
            <button className="icon-button" type="button" aria-label="Next deck" title="Next deck" disabled={selectedIndex >= sessions.length - 1} onClick={() => moveDeck(1)}><Icon name="arrow-right" /></button>
          </nav>
        </div>
        {generation.error && <div className="notice notice-error operation-notice" role="alert"><Icon name="alert" /><p>{generation.error}</p><button className="icon-button" type="button" aria-label="Dismiss operation error" onClick={generation.dismissError}><Icon name="close" /></button></div>}
        <div className={`studio-stage ${selected ? 'has-deck' : ''}`}>
          {selected ? <section className="session-stage" key={selected.id} aria-label={`Deck ${selectedIndex + 1}`}>
            <div className="session-heading"><div><p className="eyebrow">THE BRIEF <span>/ {new Date(selected.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></p><h1>{selected.prompt}</h1></div>
              <button className="text-button reuse-prompt" type="button" onClick={() => { setPrompt(selected.prompt); input.current?.focus({ preventScroll: true }); }}><Icon name="refresh" />Use prompt</button>
            </div>
            {selected.warnings.length > 0 && <div className="session-warnings">{selected.warnings.map((warning) => <p key={warning} className="notice notice-warning" role="status"><Icon name="alert" />{warning}</p>)}</div>}
            <div className="artifact-grid">{selected.artifacts.map((artifact, index) => <ArtifactCard key={artifact.id} artifact={artifact} index={index} onFocus={() => setFocus({ sessionId: selected.id, artifactId: artifact.id })} />)}</div>
            <div className="deck-caption"><span>THREE PERSPECTIVES. YOUR CALL.</span><p>Focus a design to interact, explore variations, or take the source.</p></div>
          </section> : <EmptyStudio connected={connectionReady} onConnect={() => setSettingsOpen(true)} />}
        </div>
        <PromptComposer value={prompt} onChange={setPrompt} inputRef={input} ideas={generation.ideas} canGenerate={canGenerate}
          connectionReady={connectionReady} active={active} model={connection.settings?.model} onGenerate={generate}
          onStop={() => void generation.stop()} onRefreshIdeas={generation.refreshIdeas} />
      </main>
      {inspectorOpen && <TracePanel entries={generation.trace} tracing={import.meta.env.DEV}
        onClear={generation.clearTrace} onClose={() => setInspectorOpen(false)} />}
    </div>
    <footer className="app-footer"><span>DESIGNED FOR THE POSSIBILITIES.</span><span>{loading ? 'CONNECTING TO LOCAL SERVER' : 'LOCAL ASSETS'}<i />EPHEMERAL HISTORY<i />UIHIVE 1.0</span></footer>

    {focusSession && focusedArtifact && <FocusView session={focusSession} artifact={focusedArtifact}
      deckNumber={sessions.indexOf(focusSession) + 1} active={active} canGenerate={canGenerate} onClose={() => setFocus(null)}
      onSource={() => setSource({ sessionId: focusSession.id, artifactId: focusedArtifact.id })}
      onExplore={() => generation.explore(focusSession, focusedArtifact)} onMove={moveArtifact} onStop={() => void generation.stop()} />}
    {sourceArtifact && <SourceDrawer artifact={sourceArtifact} onClose={() => setSource(null)} />}
    {variations && <VariationsDrawer variations={variations} active={active} onClose={generation.closeVariations}
      onStop={() => void generation.stop()} onApply={(id) => {
        const target = generation.applyVariation(id);
        if (target) { setSelectedSessionId(target.sessionId); setFocus(target); }
      }} />}
    {settingsOpen && <ConnectionSettings connection={connection} token={token} busy={!!active} storageError={storageError}
      onClose={() => setSettingsOpen(false)} onBusyChange={setConnectionBusy} onSaved={(next) => { setConnection(next); setStorageError(null); }} />}
  </div>;
}
