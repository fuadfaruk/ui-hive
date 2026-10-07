import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function createSecurity(origin: string, development = false) {
  const expectedHost = new URL(origin).host;
  const token = randomBytes(32).toString('base64url');

  function validOrigin(request: IncomingMessage): boolean {
    const suppliedOrigin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    return request.headers.host === expectedHost &&
      (suppliedOrigin === undefined || suppliedOrigin === origin) &&
      (site === undefined || site === 'same-origin' || site === 'none');
  }

  function headers(req: Request, res: Response, next: NextFunction) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // srcdoc inherits this CSP. Inline scripts must remain allowed here; the child
    // adds a stricter, network-free policy and always has an opaque sandbox origin.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${development ? ` ws://${expectedHost}` : ''}`,
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    if (req.path === '/api' || req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (!validOrigin(req)) return res.status(403).json({ error: 'Only the validated local app origin may access this service.' });
    next();
  }

  function mutation(req: Request, _res: Response, next: NextFunction) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.headers.origin !== origin) throw new HttpError(403, 'A matching local Origin header is required.');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new HttpError(415, 'Mutation requests must use application/json.');
    }
    const supplied = req.headers['x-ui-maker-token'];
    if (typeof supplied !== 'string' || supplied.length !== token.length || !/^[A-Za-z0-9_-]+$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      throw new HttpError(403, 'The local request token is missing or invalid. Reload the application.');
    }
    next();
  }

  return { token, headers, mutation, validOrigin };
}

export class OperationGuard {
  private active?: { id: string; controller: AbortController; settled: Promise<void>; resolve: () => void };

  acquire(id: string) {
    if (this.active) throw new HttpError(409, 'Another operation is active. Stop it or wait for it to finish.');
    const controller = new AbortController();
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    const entry = { id, controller, settled, resolve };
    this.active = entry;
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      finish: () => {
        if (this.active === entry) this.active = undefined;
        resolve();
      },
    };
  }

  async cancel(id: string) {
    if (this.active?.id !== id) return;
    const entry = this.active;
    entry.controller.abort();
    await entry.settled;
  }

  shutdown() {
    this.active?.controller.abort();
  }
}
