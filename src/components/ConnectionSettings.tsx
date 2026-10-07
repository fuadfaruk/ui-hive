import { useEffect, useId, useRef, useState } from 'react';
import { connectionUrlHint, resolveRequestUrl, validateSettings } from '../../shared/connection';
import type { ConnectionSettings as Settings, Protocol, PublicConnection } from '../../shared/types';
import { errorMessage, forgetConnection, saveConnection, testConnection } from '../api';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface Props {
  connection: PublicConnection;
  token: string | null;
  busy: boolean;
  storageError: string | null;
  onSaved: (connection: PublicConnection) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}

const defaults: Record<Protocol, string> = {
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
};

export function ConnectionSettings({ connection, token, busy, storageError, onSaved, onBusyChange, onClose }: Props) {
  const saved = connection.settings;
  const [protocol, setProtocol] = useState<Protocol>(saved?.protocol ?? 'openai');
  const [apiUrl, setApiUrl] = useState(saved?.apiUrl ?? defaults.openai);
  const [model, setModel] = useState(saved?.model ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [anthropicTokens, setAnthropicTokens] = useState(String(saved?.anthropicMaxTokens ?? 8192));
  const [limitEnabled, setLimitEnabled] = useState(!!saved?.openaiTokenLimit);
  const [limitField, setLimitField] = useState<'max_tokens' | 'max_completion_tokens'>(saved?.openaiTokenLimit?.field ?? 'max_tokens');
  const [limitValue, setLimitValue] = useState(String(saved?.openaiTokenLimit?.value ?? 8192));
  const [firstByteTimeout, setFirstByteTimeout] = useState(saved?.firstByteTimeoutMs ? String(saved.firstByteTimeoutMs) : '');
  const [inactivityTimeout, setInactivityTimeout] = useState(saved?.inactivityTimeoutMs ? String(saved.inactivityTimeoutMs) : '');
  const [destinationChanged, setDestinationChanged] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | 'forget' | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const prefix = useId();
  const disabled = busy || pending !== null || !token;
  let resolved = '';
  let urlHint = '';
  let urlError = '';
  let savedResolved = '';
  try { resolved = resolveRequestUrl(protocol, apiUrl); urlHint = connectionUrlHint(protocol, apiUrl); }
  catch (error) { urlError = errorMessage(error); }
  try { if (saved) savedResolved = resolveRequestUrl(saved.protocol, saved.apiUrl); } catch { /* Invalid saved settings cannot retain a key. */ }
  const canKeep = connection.hasKey && !!saved && !destinationChanged &&
    protocol === saved.protocol && !!resolved && resolved === savedResolved;

  useEffect(() => () => request.current?.abort(), []);

  function changeDestination(nextProtocol: Protocol, nextUrl: string) {
    setProtocol(nextProtocol);
    setApiUrl(nextUrl);
    setFeedback(null);
    if (!saved || !connection.hasKey) return;
    try {
      if (nextProtocol !== saved.protocol || resolveRequestUrl(nextProtocol, nextUrl) !== savedResolved) setDestinationChanged(true);
    } catch { setDestinationChanged(true); }
  }

  function payload(): { settings: Settings; key: { action: 'replace'; value: string } | { action: 'keep' } } {
    const settings = validateSettings({
      protocol, apiUrl, model, anthropicMaxTokens: Number(anthropicTokens),
      ...(protocol === 'openai' && limitEnabled ? { openaiTokenLimit: { field: limitField, value: Number(limitValue) } } : {}),
      ...(firstByteTimeout.trim() ? { firstByteTimeoutMs: Number(firstByteTimeout) } : {}),
      ...(inactivityTimeout.trim() ? { inactivityTimeoutMs: Number(inactivityTimeout) } : {}),
    });
    if (keyDraft.trim()) return { settings, key: { action: 'replace', value: keyDraft.trim() } };
    if (canKeep) return { settings, key: { action: 'keep' } };
    throw new Error('Enter an API key for this destination. A saved key cannot be reused after changing the protocol or destination.');
  }

  function reflectSaved(next: PublicConnection) {
    setProtocol(next.settings?.protocol ?? 'openai');
    setApiUrl(next.settings?.apiUrl ?? defaults.openai);
    setModel(next.settings?.model ?? '');
    setAnthropicTokens(String(next.settings?.anthropicMaxTokens ?? 8192));
    setLimitEnabled(!!next.settings?.openaiTokenLimit);
    setLimitField(next.settings?.openaiTokenLimit?.field ?? 'max_tokens');
    setLimitValue(String(next.settings?.openaiTokenLimit?.value ?? 8192));
    setFirstByteTimeout(next.settings?.firstByteTimeoutMs ? String(next.settings.firstByteTimeoutMs) : '');
    setInactivityTimeout(next.settings?.inactivityTimeoutMs ? String(next.settings.inactivityTimeoutMs) : '');
    setKeyDraft('');
    setDestinationChanged(false);
    onSaved(next);
  }

  async function perform(action: 'save' | 'test' | 'forget') {
    if (disabled || request.current || !token) return;
    setFeedback(null);
    let draft: ReturnType<typeof payload> | undefined;
    try { if (action !== 'forget') draft = payload(); }
    catch (cause) { setFeedback({ kind: 'error', message: errorMessage(cause) }); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(action);
    onBusyChange(true);
    try {
      if (action === 'test' && draft) {
        const message = await testConnection(token, draft.settings, draft.key, controller.signal);
        setFeedback({ kind: 'success', message: `${message} Draft settings have not been saved.` });
      } else if (action === 'save' && draft) {
        reflectSaved(await saveConnection(token, draft.settings, draft.key, controller.signal));
        setFeedback({ kind: 'success', message: 'Connection saved. Your studio is ready to generate.' });
      } else if (action === 'forget') {
        reflectSaved(await forgetConnection(token, controller.signal));
        setFeedback({ kind: 'success', message: 'The saved connection and its key have been deleted.' });
      }
    } catch (cause) {
      if (!controller.signal.aborted) setFeedback({ kind: 'error', message: errorMessage(cause) });
    } finally {
      request.current = null;
      setPending(null);
      onBusyChange(false);
    }
  }

  return <Modal title="Connection settings" eyebrow="THE LOCAL CONNECTION" onClose={onClose} dismissDisabled={pending !== null}
    description="Your endpoint. Your model. One locally saved connection." className="connection-modal">
    <form className="drawer-body connection-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void perform('save'); }}>
      {busy && <div className="notice notice-info" role="status"><Icon name="clock" /><p>Connection controls are locked until the active operation and its cleanup finish.</p></div>}
      {!token && <div className="notice notice-warning" role="status"><Icon name="alert" /><p>The local connection has not finished loading. Saving and testing are unavailable.</p></div>}
      {storageError && <div className="notice notice-error" role="alert"><Icon name="alert" /><div><strong>Saved connection needs attention</strong><p>{storageError}</p><p>Save a replacement or use Forget Key to remove the saved connection.</p></div></div>}
      <fieldset disabled={disabled} className="settings-fields">
        <div className="field">
          <label htmlFor={`${prefix}-protocol`}>Protocol</label>
          <select id={`${prefix}-protocol`} value={protocol} onChange={(event) => {
            const next = event.target.value as Protocol;
            changeDestination(next, apiUrl === defaults[protocol] ? defaults[next] : apiUrl);
          }}>
            <option value="openai">OpenAI-compatible / Chat Completions</option>
            <option value="anthropic">Anthropic-compatible / Messages</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-url`}>API URL</label>
          <input id={`${prefix}-url`} type="url" required value={apiUrl} maxLength={2048} spellCheck={false}
            aria-describedby={`${prefix}-url-hint`} aria-invalid={!!urlError} placeholder={defaults[protocol]}
            onChange={(event) => changeDestination(protocol, event.target.value)} />
          <p id={`${prefix}-url-hint`} className={`field-help ${urlError ? 'text-warning' : ''}`}>{urlError || urlHint}</p>
        </div>
        <div className="resolved-endpoint">
          <span className="eyebrow">RESOLVED REQUEST URL</span>
          <output aria-label="Resolved request URL">{resolved || 'Enter a valid API URL to resolve the request path.'}</output>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-model`}>Model ID <span>Manually entered</span></label>
          <input id={`${prefix}-model`} value={model} required maxLength={200} autoCapitalize="none" spellCheck={false}
            placeholder="Your provider's exact model ID" onChange={(event) => { setModel(event.target.value); setFeedback(null); }} />
          <p className="field-help">Use the model name your endpoint accepts. No model-list request is made.</p>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-key`}>API key {connection.hasKey && <span><Icon name="key" /> A key is saved</span>}</label>
          <input id={`${prefix}-key`} type="password" value={keyDraft} autoComplete="off" spellCheck={false} maxLength={8192}
            aria-describedby={`${prefix}-key-hint`} placeholder={canKeep ? 'Leave empty to keep the saved key' : 'Enter your API key'}
            onChange={(event) => { setKeyDraft(event.target.value); setFeedback(null); }} />
          <p id={`${prefix}-key-hint`} className={`field-help ${destinationChanged ? 'text-warning' : ''}`}>
            {destinationChanged ? 'The destination was edited. Enter a key again, even if you returned to the saved URL.'
              : canKeep ? 'An empty field explicitly keeps the saved key for this exact protocol and destination. Model-only changes are safe.'
                : 'Encrypted by the local Windows server. Never stored by this app in the browser.'}
          </p>
        </div>
        {protocol === 'anthropic' ? <div className="field">
          <label htmlFor={`${prefix}-anthropic-tokens`}>Anthropic output-token limit</label>
          <input id={`${prefix}-anthropic-tokens`} type="number" required min="1" max="262144" step="1"
            value={anthropicTokens} onChange={(event) => { setAnthropicTokens(event.target.value); setFeedback(null); }} />
          <p className="field-help">Messages requires a positive output limit. The starting value is 8192.</p>
        </div> : <details className="advanced-settings">
          <summary>Advanced output limit <span>Optional</span></summary>
          <label className="checkbox-field" htmlFor={`${prefix}-limit-enabled`}>
            <input id={`${prefix}-limit-enabled`} type="checkbox" checked={limitEnabled}
              onChange={(event) => { setLimitEnabled(event.target.checked); setFeedback(null); }} />
            Set an explicit OpenAI output limit
          </label>
          <p className="field-help">Off by default. Choose the field your model supports; UIHive does not guess.</p>
          {limitEnabled && <div className="field-pair">
            <div className="field"><label htmlFor={`${prefix}-limit-field`}>Token-limit field</label>
              <select id={`${prefix}-limit-field`} value={limitField} onChange={(event) => { setLimitField(event.target.value as typeof limitField); setFeedback(null); }}>
                <option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </div>
            <div className="field"><label htmlFor={`${prefix}-limit-value`}>Output tokens</label>
              <input id={`${prefix}-limit-value`} type="number" min="1" max="262144" step="1" required value={limitValue}
                onChange={(event) => { setLimitValue(event.target.value); setFeedback(null); }} />
            </div>
          </div>}
        </details>}
        <div className="timeout-settings">
          <span className="eyebrow">TIMEOUTS</span>
          <div className="field-pair">
            <div className="field">
              <label htmlFor={`${prefix}-first-byte`}>First-byte timeout <span>Optional</span></label>
              <input id={`${prefix}-first-byte`} type="number" min="1000" max="1800000" step="1000"
                value={firstByteTimeout} placeholder="90000" aria-describedby={`${prefix}-timeout-hint`}
                onChange={(event) => { setFirstByteTimeout(event.target.value); setFeedback(null); }} />
            </div>
            <div className="field">
              <label htmlFor={`${prefix}-inactivity`}>Inactivity timeout <span>Optional</span></label>
              <input id={`${prefix}-inactivity`} type="number" min="1000" max="1800000" step="1000"
                value={inactivityTimeout} placeholder="45000" aria-describedby={`${prefix}-timeout-hint`}
                onChange={(event) => { setInactivityTimeout(event.target.value); setFeedback(null); }} />
            </div>
          </div>
          <p id={`${prefix}-timeout-hint`} className="field-help">Milliseconds. The first-byte timeout waits for the provider to start responding; the inactivity timeout bounds each pause after that. Leave both blank to use the built-in defaults.</p>
        </div>
        <div className="connection-actions">
          <button className="button button-primary" type="submit" aria-label="Save Connection">
            {pending === 'save' ? <span className="spinner" /> : <Icon name="check" />}{pending === 'save' ? 'Saving...' : 'Save Connection'}
          </button>
          <button className="button button-secondary" type="button" aria-label="Test Connection" onClick={() => void perform('test')}>
            {pending === 'test' ? <span className="spinner" /> : <Icon name="bolt" />}{pending === 'test' ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
        <p className="paid-notice">Test Connection sends a small paid request using this draft. Provider charges can apply. Testing never saves your settings.</p>
        <div className="forget-row">
          <p>Remove the whole saved connection, including its encrypted key.</p>
          <button className="button button-danger-subtle" type="button" aria-label="Forget Key"
            disabled={!connection.hasKey && !connection.settings && !storageError} onClick={() => void perform('forget')}>
            {pending === 'forget' ? 'Forgetting...' : 'Forget Key'}
          </button>
        </div>
      </fieldset>
      {feedback && <div className={`notice notice-${feedback.kind === 'error' ? 'error' : 'success'}`}
        role={feedback.kind === 'error' ? 'alert' : 'status'}>
        <Icon name={feedback.kind === 'error' ? 'alert' : 'check'} /><p>{feedback.message}</p>
      </div>}
      <aside className="security-note">
        <Icon name="shield" /><div><strong>Local by design. Honest about the limits.</strong>
          <p>Windows account encryption is not protection from hostile apps running as the same user. Prompts and deck history live only in this tab and disappear on reload.</p>
          <p>Previews block external resources. Sandboxing does not prevent resource exhaustion or every iframe navigation. Downloaded HTML is untrusted and runs outside the preview sandbox.</p>
        </div>
      </aside>
    </form>
  </Modal>;
}
