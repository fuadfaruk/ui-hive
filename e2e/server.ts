import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { startLocalServer } from '../server/index.js';
import type { CredentialStore, SavedConnection } from '../server/connection.js';

// A test-only store and provider keep browser tests off real credentials and APIs.
let connection: SavedConnection | null = null;
const store: CredentialStore = {
  async read() { return structuredClone(connection); },
  async write(value) { connection = structuredClone(value); },
  async forget() { connection = null; },
};
const names = ['Pressed Paper', 'Etched Alloy', 'Woven Light'];
const stats = { plans: 0, html: 0, variations: 0, ideas: 0, tests: 0, leaks: 0, aborted: 0, active: 0, maxActive: 0 };

function html(name: string, index = 0) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><style>
  *{box-sizing:border-box}body{margin:0;background:${index % 2 ? '#dce4df' : '#f3efe4'};color:#20392d;font-family:Georgia,serif;padding:clamp(20px,5vw,70px)}header{display:flex;justify-content:space-between;border-bottom:1px solid #829186;padding-bottom:20px;font:12px monospace;letter-spacing:2px}main{max-width:650px;margin:12vh auto}p{line-height:1.7}h1{font-size:clamp(42px,8vw,86px);line-height:.98;font-weight:400;letter-spacing:-4px}button{background:#20392d;color:#f3efe4;border:0;border-radius:50px;padding:15px 24px;cursor:pointer;font:14px monospace}button:hover{background:#3a5948}.dial{width:80px;height:80px;border:1px solid #84998a;border-radius:50%;display:grid;place-items:center;font:20px monospace}footer{font:11px monospace;letter-spacing:1px}.embedded-quote:after{content:"}"}@media(prefers-reduced-motion:reduce){*{animation:none!important}}
  </style></head><body><header><span>STILL / FIELD</span><span>${name}</span></header><main><div class="dial" id="counter">0</div><h1>Make room<br>for a little focus.</h1><p>A quiet space for the work that matters.<br>One intention. One moment. A fresh beginning.</p><button id="start">Start focus</button></main><footer>A LOCAL, SELF-CONTAINED DESIGN STUDY</footer><script>
  document.getElementById('start').addEventListener('click',()=>{document.getElementById('counter').textContent=String(Number(document.getElementById('counter').textContent)+1)});
  try{parent.document.body.dataset.previewEscaped='yes'}catch{document.body.dataset.parentBlocked='true'}
  fetch('http://127.0.0.1:4319/leak').catch(()=>{document.body.dataset.fetchBlocked='true'});
  </script><img alt="" src="http://127.0.0.1:4319/leak" style="display:none"></body></html>`;
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function stream(res: ServerResponse, output: string, protocol: 'openai' | 'anthropic', slow: boolean, truncated: boolean) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  const send = (data: unknown, event?: string) => {
    if (!res.destroyed) res.write(`${event ? `event: ${event}\r\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`);
  };
  const chunks = output.match(/[\s\S]{1,220}/g) ?? [];
  if (protocol === 'anthropic') {
    send({ type: 'message_start', message: { id: 'msg_fake', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }, 'message_start');
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: chunks.shift() ?? '' } }, 'content_block_start');
  } else {
    send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  }
  for (const chunk of chunks) {
    if (res.destroyed) { stats.aborted++; return; }
    if (protocol === 'openai') send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
    else send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, 'content_block_delta');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, slow ? 700 : 8);
      function done() { clearTimeout(timer); res.off('close', done); resolve(); }
      res.once('close', done);
      if (res.destroyed) done();
    });
  }
  if (res.destroyed) { stats.aborted++; return; }
  if (protocol === 'openai') {
    send({ choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }] });
    send('[DONE]');
  } else {
    send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
    send({ type: 'message_delta', delta: { stop_reason: truncated ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 20 } }, 'message_delta');
    send({ type: 'message_stop' }, 'message_stop');
  }
  res.end();
}

const mock = createServer(async (req, res) => {
  if (req.url === '/_test/stats') { json(res, stats); return; }
  if (req.url === '/_test/reset' && req.method === 'POST') {
    for (const key of Object.keys(stats) as Array<keyof typeof stats>) stats[key] = 0;
    json(res, { ok: true }); return;
  }
  if (req.url === '/leak') { stats.leaks++; json(res, { error: 'Preview network access escaped' }); return; }
  const protocol = req.url === '/v1/messages' ? 'anthropic' : 'openai';
  if (req.method !== 'POST' || (req.url !== '/v1/messages' && req.url !== '/v1/chat/completions')) {
    json(res, { error: 'Unknown mock operation' }, 404); return;
  }
  if ((protocol === 'openai' ? req.headers.authorization : req.headers['x-api-key']) !==
    (protocol === 'openai' ? 'Bearer fake-e2e-key' : 'fake-e2e-key')) {
    json(res, { error: { message: 'Only the disposable test key is accepted' } }, 401); return;
  }
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) throw new Error('Mock body exceeded limit');
    }
    const body = JSON.parse(raw) as { model: string; stream: boolean; system?: string; messages: Array<{ role: string; content: string }> };
    const system = body.system ?? body.messages.find((message) => message.role === 'system')?.content ?? '';
    const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
    if (body.model === 'mock-auth') { json(res, { error: { message: 'Rejected fake-e2e-key' } }, 401); return; }
    if (!body.stream) {
      let output: string;
      if (system.includes('connection test')) { stats.tests++; output = 'OK'; }
      else if (system.includes('Propose twenty')) {
        stats.ideas++;
        output = JSON.stringify(Array.from({ length: 20 }, (_, index) => `Design a tactile local-only workspace for creative practice ${index + 1}`));
      } else { stats.plans++; output = JSON.stringify(names); }
      json(res, protocol === 'openai'
        ? { choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }] }
        : { content: [{ type: 'text', text: output }], stop_reason: 'end_turn' });
      return;
    }
    if (system.includes('radical conceptual variations')) {
      stats.variations++;
      const output = names.map((name, index) => JSON.stringify({ name: `Recast ${name}`, html: html(`Recast ${name}`, index + 1) })).join('\n');
      await stream(res, output, protocol, body.model === 'mock-slow', false);
      return;
    }
    stats.html++;
    const index = names.findIndex((name) => user.includes(name));
    if (body.model === 'mock-one-error' && index === 1) { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('<html>fake-e2e-key should never appear in the UI</html>'); return; }
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      await stream(res, html(names[index] ?? names[0], index), protocol, body.model === 'mock-slow', body.model === 'mock-truncated');
    } finally { stats.active--; }
  } catch {
    if (!res.headersSent) json(res, { error: 'Mock request failed' }, 400);
    else res.end();
  }
});
mock.listen(4319, '127.0.0.1');
await once(mock, 'listening');
const app = await startLocalServer({ port: 3141, store });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  mock.closeAllConnections();
  mock.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
