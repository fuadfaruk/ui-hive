import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import express from 'express';
import type { ViteDevServer } from 'vite';
import { log } from '../shared/diagnostics.js';
import { createLocalApp } from './app.js';
import type { CredentialStore } from './connection.js';

export async function startLocalServer(options: { port?: number; production?: boolean; store?: CredentialStore } = {}) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const origin = `http://127.0.0.1:${port}`;
  const { app, security, shutdown } = createLocalApp({ origin, development: !options.production, store: options.store });
  const server = createServer(app);
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  log.server('info', 'startup', 'http server limits', {
    headersTimeout: server.headersTimeout,
    requestTimeout: server.requestTimeout,
    keepAliveTimeout: server.keepAliveTimeout,
    node: process.version,
    production: !!options.production,
  });
  // Vite's WebSocket upgrade does not pass through Express middleware.
  server.on('upgrade', (request, socket) => {
    if (!security.validOrigin(request)) socket.destroy();
  });
  let vite: ViteDevServer | undefined;
  if (options.production) {
    const client = fileURLToPath(new URL('../client/', import.meta.url));
    app.use(express.static(client, { index: false }));
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(resolve(client, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const root = fileURLToPath(new URL('../', import.meta.url));
    vite = await createViteServer({
      root,
      configFile: resolve(root, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server, host: '127.0.0.1', clientPort: port },
        cors: false,
        allowedHosts: ['127.0.0.1'],
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  console.log(`UIHive is ready at ${origin} (${options.production ? 'production' : 'development'}).`);
  return {
    server,
    origin,
    async close() {
      shutdown();
      await vite?.close();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startLocalServer({ port: Number(process.env.PORT ?? 3000), production: process.argv.includes('--production') })
    .then((local) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        void local.close().catch(() => { process.exitCode = 1; });
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    })
    .catch((error: unknown) => {
      console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? 'The local port is in use. Close the other server or choose another PORT.'
        : 'UIHive could not start. Verify Node 24, Windows storage access, and the production build.');
      process.exitCode = 1;
    });
}
