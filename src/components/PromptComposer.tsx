import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { LIMITS } from '../../shared/types';
import { SEED_PROMPTS } from '../constants';
import type { ActiveOperation } from '../useGeneration';
import { Icon } from './Icon';

interface Props {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  ideas: string[];
  canGenerate: boolean;
  connectionReady: boolean;
  active: ActiveOperation | null;
  model: string | undefined;
  onGenerate: (prompt?: string) => void;
  onStop: () => void;
  onRefreshIdeas: () => void;
}

export function PromptComposer({ value, onChange, inputRef, ideas, canGenerate, connectionReady, active, model, onGenerate, onStop, onRefreshIdeas }: Props) {
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const valid = !!value.trim() && value.trim().length <= LIMITS.prompt;
  const visibleIdeas = ideas.length > SEED_PROMPTS.length ? ideas.slice(-3) : ideas.slice(0, 3);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    function update() {
      if (timer !== undefined) window.clearInterval(timer);
      if (!preference.matches) timer = window.setInterval(() => setPlaceholderIndex((index) => (index + 1) % ideas.length), 6500);
    }
    update();
    preference.addEventListener('change', update);
    return () => { window.clearInterval(timer); preference.removeEventListener('change', update); };
  }, [ideas.length]);

  function useIdea(idea: string) {
    onChange(idea);
    inputRef.current?.focus({ preventScroll: true });
  }

  return <section className="composer-area" aria-label="Design prompt composer">
    <div className="seed-row">
      <span className="seed-label"><Icon name="sparkles" />A starting point</span>
      <div className="seed-buttons">
        {visibleIdeas.map((idea) => <button key={idea} className="seed-button" type="button" title={idea}
          aria-label={`Use idea: ${idea}`} onClick={() => useIdea(idea)}>{idea.replace(/ with .*| inspired by .*|, with .*/, '')}</button>)}
      </div>
      <button className="text-button refresh-ideas" type="button" disabled={!canGenerate} onClick={onRefreshIdeas}
        title="Explicit paid request. No prompt ideas are requested automatically." aria-label="Refresh Ideas">
        <Icon name="refresh" className={active?.kind === 'ideas' && !active.stopping ? 'is-spinning' : ''} /><span>Refresh Ideas</span>
      </button>
    </div>
    <form className={`prompt-composer ${active ? 'composer-working' : ''}`} onSubmit={(event) => { event.preventDefault(); if (canGenerate && valid) onGenerate(); }}>
      <div className="composer-label-row"><label htmlFor="design-prompt">Design prompt</label><span>ONE BRIEF. THREE DIRECTIONS.</span></div>
      <textarea id="design-prompt" ref={inputRef} data-composer-input value={value} rows={2} maxLength={LIMITS.prompt}
        placeholder={ideas[placeholderIndex % ideas.length]} spellCheck aria-describedby="composer-help"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && canGenerate && valid) {
            event.preventDefault(); onGenerate();
          }
        }} />
      <div className="composer-actions">
        <button className="button button-surprise" type="button" disabled={!canGenerate} title="Generate three directions from a seed. Provider charges may apply."
          onClick={() => {
            const idea = ideas[placeholderIndex % ideas.length];
            onChange(idea);
            onGenerate(idea);
          }}><Icon name="sparkles" />Surprise Me</button>
        <div className="composer-submit-group">
          <span className="composer-key-hint">{value.length > 10000 ? `${value.length.toLocaleString()} / ${LIMITS.prompt.toLocaleString()}` : <><kbd>Enter</kbd> to generate</>}</span>
          {active ? <button className="button button-stop" type="button" aria-label="Stop" disabled={active.stopping} onClick={onStop}>
            {active.stopping ? <span className="spinner" /> : <Icon name="stop" />}{active.stopping ? 'Stopping...' : 'Stop'}
          </button> : <button className="button button-primary generate-button" type="submit" disabled={!canGenerate || !valid} aria-label="Generate">Generate<Icon name="arrow-right" /></button>}
        </div>
      </div>
    </form>
    <div className="composer-footer">
      <p id="composer-help" aria-live="polite">{active ? <><i className="status-dot is-live" />{active.stopping ? 'Stopping and releasing the connection...'
        : active.kind === 'generate' ? 'Building three directions. You can browse other decks while they stream.'
          : active.kind === 'variations' ? 'Exploring variations of your captured design.' : 'Refreshing prompt ideas. Your seeded ideas stay available.'}</>
        : connectionReady ? <><i className="status-dot is-connected" /><span className="connection-model" title={model}>{model}</span><span className="footer-separator" />Ready when you are.</>
          : <><Icon name="key" />Save a connection to start generating.</>}</p>
      <span className="request-disclosure">Generation and refreshed ideas use your provider. Charges may apply.</span>
    </div>
  </section>;
}
