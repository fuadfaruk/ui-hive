import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { diagnosticsClear, diagnosticsDump, log } from '../shared/diagnostics';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('UIHive could not find its application root.');

// After reproducing a problem, run `copy(__dumpUiHiveLogs())` in the browser
// console (or call it and paste the string) to return the full client log.
Object.assign(window, {
  __dumpUiHiveLogs: () => diagnosticsDump(),
  __clearUiHiveLogs: () => { diagnosticsClear(); return 'cleared'; },
});

log.info('client', 'studio booting', {
  href: window.location.href,
  userAgent: navigator.userAgent,
  diagnostics: 'run __dumpUiHiveLogs() to copy the client log; set window.__UI_MAKER_DEBUG = false before reload to silence',
});

createRoot(root).render(<StrictMode><App /></StrictMode>);
