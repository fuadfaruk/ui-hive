import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveRequestUrl, validateSettings } from '../shared/connection.js';
import type { ConnectionSettings, PublicConnection } from '../shared/types.js';

export interface SavedConnection {
  settings: ConnectionSettings;
  key: string;
}

export interface CredentialStore {
  read(): Promise<SavedConnection | null>;
  write(connection: SavedConnection): Promise<void>;
  forget(): Promise<void>;
}

export class ConnectionError extends Error {
  constructor(message: string, public readonly statusCode = 500) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface Protection {
  protect(data: Buffer): Buffer | Promise<Buffer>;
  unprotect(data: Buffer): Buffer | Promise<Buffer>;
}

async function dpapi() {
  if (process.platform !== 'win32') {
    throw new ConnectionError('Protected connection storage requires Windows. No plaintext fallback is available.');
  }
  try {
    const native = await import('@primno/dpapi');
    if (!native.isPlatformSupported) throw new Error('Unsupported platform');
    return native.Dpapi;
  } catch {
    throw new ConnectionError('Windows account encryption is unavailable. Repair the DPAPI installation before saving a connection.');
  }
}

export const windowsProtection: Protection = {
  async protect(data) {
    return Buffer.from((await dpapi()).protectData(data, null, 'CurrentUser'));
  },
  async unprotect(data) {
    return Buffer.from((await dpapi()).unprotectData(data, null, 'CurrentUser'));
  },
};

function defaultConnectionPath(): string {
  if (!process.env.LOCALAPPDATA) {
    throw new ConnectionError('Windows LocalAppData is unavailable. A protected connection cannot be stored.');
  }
  return join(process.env.LOCALAPPDATA, 'UI-Maker', 'connection.json');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw new ConnectionError('Enter an API key of at most 8192 characters without whitespace or control characters.', 400);
  }
  return value.trim();
}

// Only ciphertext is ever written, including the temporary replacement file.
export class EncryptedConnectionStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string = defaultConnectionPath(),
    private readonly protection: Protection = windowsProtection,
    private readonly files: Pick<typeof fs, 'readFile' | 'stat' | 'mkdir' | 'open' | 'rename' | 'unlink'> = fs,
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  read(): Promise<SavedConnection | null> {
    return this.serial(async () => {
      let encoded: string;
      try {
        const info = await this.files.stat(this.filePath);
        if (!info.isFile() || info.size > 128 * 1024) throw new Error('Invalid envelope');
        encoded = await this.files.readFile(this.filePath, 'utf8');
      } catch (error) {
        if (missing(error)) return null;
        throw new ConnectionError('The protected connection file could not be read. Check its permissions and integrity.');
      }
      let clear: Buffer | undefined;
      try {
        const envelope = JSON.parse(encoded) as { version?: unknown; ciphertext?: unknown };
        if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' ||
          !envelope.ciphertext || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)) {
          throw new Error('Invalid envelope');
        }
        clear = await this.protection.unprotect(Buffer.from(envelope.ciphertext, 'base64'));
        const record = JSON.parse(clear.toString('utf8')) as SavedConnection;
        return { settings: validateSettings(record.settings), key: validateKey(record.key) };
      } catch (error) {
        if (error instanceof ConnectionError && error.statusCode === 500) throw error;
        throw new ConnectionError('The saved connection is corrupt or cannot be decrypted by this Windows account. Re-enter the connection or use Forget Key.');
      } finally {
        clear?.fill(0);
      }
    });
  }

  write(connection: SavedConnection): Promise<void> {
    return this.serial(async () => {
      const record = { settings: validateSettings(connection.settings), key: validateKey(connection.key) };
      const clear = Buffer.from(JSON.stringify(record), 'utf8');
      let ciphertext: Buffer;
      try {
        ciphertext = await this.protection.protect(clear);
        if (!ciphertext.length) throw new Error('Empty ciphertext');
      } catch (error) {
        if (error instanceof ConnectionError) throw error;
        throw new ConnectionError('Windows encryption failed. The previous connection has not been changed.');
      } finally {
        clear.fill(0);
      }
      const envelope = JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await this.files.mkdir(dirname(this.filePath), { recursive: true });
        const handle = await this.files.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(envelope, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.files.rename(temporary, this.filePath);
      } catch {
        await this.files.unlink(temporary).catch(() => undefined);
        throw new ConnectionError('The protected connection could not be saved. The previous connection has not been changed.');
      }
    });
  }

  forget(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.files.unlink(this.filePath);
      } catch (error) {
        if (!missing(error)) {
          throw new ConnectionError('The protected connection could not be deleted. The saved key is still present.');
        }
      }
    });
  }
}

export function publicConnection(record: SavedConnection | null): PublicConnection {
  return record
    ? { settings: record.settings, hasKey: true, resolvedUrl: resolveRequestUrl(record.settings.protocol, record.settings.apiUrl) }
    : { settings: null, hasKey: false, resolvedUrl: null };
}

export class ConnectionService {
  constructor(private readonly store: CredentialStore) {}

  async public(): Promise<PublicConnection> {
    return publicConnection(await this.store.read());
  }

  async snapshot(): Promise<SavedConnection> {
    const record = await this.store.read();
    if (!record) throw new ConnectionError('Save a connection before generating designs.', 409);
    const snapshot = structuredClone(record);
    if (snapshot.settings.openaiTokenLimit) Object.freeze(snapshot.settings.openaiTokenLimit);
    Object.freeze(snapshot.settings);
    return Object.freeze(snapshot);
  }

  async prepare(input: unknown): Promise<SavedConnection> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ConnectionError('Connection settings and a key action are required.', 400);
    }
    const draft = input as Record<string, unknown>;
    let settings: ConnectionSettings;
    try {
      settings = validateSettings(draft.settings);
    } catch (error) {
      throw new ConnectionError((error as Error).message, 400);
    }
    const keyAction = draft.key as Record<string, unknown> | undefined;
    if (keyAction?.action === 'replace') {
      return { settings, key: validateKey(keyAction.value) };
    }
    if (keyAction?.action !== 'keep') {
      throw new ConnectionError('Enter a new key or explicitly keep the saved key.', 400);
    }
    const previous = await this.store.read();
    if (!previous) throw new ConnectionError('No saved key exists. Enter an API key.', 400);
    if (previous.settings.protocol !== settings.protocol ||
      resolveRequestUrl(previous.settings.protocol, previous.settings.apiUrl) !== resolveRequestUrl(settings.protocol, settings.apiUrl)) {
      throw new ConnectionError('Changing the protocol or request destination requires re-entering the API key.', 400);
    }
    return { settings, key: previous.key };
  }

  async save(input: unknown): Promise<PublicConnection> {
    const record = await this.prepare(input);
    await this.store.write(record);
    return publicConnection(record);
  }

  async forget(): Promise<PublicConnection> {
    await this.store.forget();
    return publicConnection(null);
  }
}
