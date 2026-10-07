import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionService, EncryptedConnectionStore, type Protection } from '../server/connection.js';
import { connectionUrlHint, resolveRequestUrl, validateSettings } from '../shared/connection.js';
import { MemoryStore, saved, settings } from './helpers.js';

const directories: string[] = [];
async function storagePath() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ui-maker-storage-test-'));
  directories.push(directory);
  return join(directory, 'connection.json');
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

function testProtection(): Protection {
  const key = randomBytes(32);
  return {
    protect(clear) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    unprotect(ciphertext) {
      const cipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      cipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([cipher.update(ciphertext.subarray(28)), cipher.final()]);
    },
  };
}

describe('request destination and settings validation', () => {
  it.each([
    ['openai', 'https://gateway.example/v1', 'https://gateway.example/v1/chat/completions'],
    ['openai', 'https://gateway.example/v1/', 'https://gateway.example/v1/chat/completions'],
    ['openai', 'https://gateway.example/custom/team/v4/chat/completions/', 'https://gateway.example/custom/team/v4/chat/completions'],
    ['anthropic', 'https://gateway.example/custom/v1', 'https://gateway.example/custom/v1/messages'],
    ['anthropic', 'https://gateway.example/custom/messages/', 'https://gateway.example/custom/messages'],
    ['openai', 'http://127.0.0.1:4040', 'http://127.0.0.1:4040/chat/completions'],
    ['anthropic', 'http://[::1]:4040/v1', 'http://[::1]:4040/v1/messages'],
    ['openai', 'http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
  ] as const)('%s resolves %s exactly', (protocol, input, expected) => {
    expect(resolveRequestUrl(protocol, input)).toBe(expected);
  });

  it.each([
    'https://user:password@gateway.example/v1', 'https://gateway.example/v1?api_key=test',
    'https://gateway.example/v1#secret', 'file:///etc/passwd', 'ftp://gateway.example',
    'http://gateway.example/v1', 'http://localhost.evil.example/v1', 'http://192.168.1.1/v1',
    'not-a-url',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => resolveRequestUrl('openai', url)).toThrow();
  });

  it('rejects operation/protocol mismatches without guessing a version prefix', () => {
    expect(() => resolveRequestUrl('openai', 'https://gateway.example/v1/messages/')).toThrow('other protocol');
    expect(() => resolveRequestUrl('anthropic', 'https://gateway.example/v1/chat/completions')).toThrow('other protocol');
    expect(resolveRequestUrl('openai', 'https://gateway.example')).toBe('https://gateway.example/chat/completions');
    expect(connectionUrlHint('openai', 'https://gateway.example')).toContain('not added automatically');
  });

  it('accepts free-form models and only explicit bounded token limits', () => {
    expect(validateSettings(settings)).toEqual(settings);
    expect(validateSettings({ ...settings, openaiTokenLimit: { field: 'max_completion_tokens', value: 32768 } }).openaiTokenLimit?.field).toBe('max_completion_tokens');
    expect(() => validateSettings({ ...settings, anthropicMaxTokens: 0 })).toThrow('positive integer');
    expect(() => validateSettings({ ...settings, openaiTokenLimit: { field: 'auto', value: 99 } })).toThrow();
    expect(() => validateSettings({ ...settings, model: '\r\nInjected' })).toThrow('control characters');
    expect(() => validateSettings({ ...settings, model: ' ' })).toThrow();
  });

  it('accepts bounded optional timeouts and rejects out-of-range or non-integer values', () => {
    expect(validateSettings({ ...settings, firstByteTimeoutMs: 180000, inactivityTimeoutMs: 45000 }))
      .toEqual({ ...settings, firstByteTimeoutMs: 180000, inactivityTimeoutMs: 45000 });
    expect(validateSettings({ ...settings, inactivityTimeoutMs: 1000 }).inactivityTimeoutMs).toBe(1000);
    expect(validateSettings({ ...settings, firstByteTimeoutMs: 1_800_000 }).firstByteTimeoutMs).toBe(1_800_000);
    expect(validateSettings({ ...settings, firstByteTimeoutMs: null })).toEqual(settings);
    for (const value of [999, 1_800_001, 1000.5, 0, -1000, '45000', Number.NaN]) {
      expect(() => validateSettings({ ...settings, firstByteTimeoutMs: value })).toThrow('milliseconds');
      expect(() => validateSettings({ ...settings, inactivityTimeoutMs: value })).toThrow('milliseconds');
    }
  });
});

describe('encrypted connection storage', () => {
  it('saves, reloads, atomically replaces, and deletes only encrypted envelopes', async () => {
    const path = await storagePath();
    const protection = testProtection();
    const store = new EncryptedConnectionStore(path, protection);
    expect(await store.read()).toBeNull();
    await store.write(saved);
    const encoded = await fs.readFile(path, 'utf8');
    expect(encoded).not.toContain(saved.key);
    expect(encoded).not.toContain(settings.apiUrl);
    expect(Object.keys(JSON.parse(encoded))).toEqual(['version', 'ciphertext']);
    expect(await new EncryptedConnectionStore(path, protection).read()).toEqual(saved);
    const next = { ...saved, settings: { ...settings, model: 'replacement-model' }, key: 'replacement-fake-key' };
    await store.write(next);
    expect(await store.read()).toEqual(next);
    expect(await fs.readdir(join(path, '..'))).toEqual(['connection.json']);
    await store.forget();
    expect(await store.read()).toBeNull();
    await expect(store.forget()).resolves.toBeUndefined();
  });

  it('serializes simultaneous replacement operations', async () => {
    const path = await storagePath();
    const store = new EncryptedConnectionStore(path, testProtection());
    await Promise.all([
      store.write({ ...saved, key: 'first-fake-key' }),
      store.write({ ...saved, key: 'second-fake-key' }),
      store.write({ ...saved, key: 'third-fake-key' }),
    ]);
    expect((await store.read())?.key).toBe('third-fake-key');
  });

  it('preserves the previous record when atomic replacement fails', async () => {
    const path = await storagePath();
    const protection = testProtection();
    const original = new EncryptedConnectionStore(path, protection);
    await original.write(saved);
    const before = await fs.readFile(path, 'utf8');
    const failing = new EncryptedConnectionStore(path, protection, {
      ...fs, rename: async () => { throw new Error('Simulated locked destination'); },
    });
    await expect(failing.write({ ...saved, key: 'new-fake-key' })).rejects.toThrow('previous connection has not been changed');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(await original.read()).toEqual(saved);
    expect(await fs.readdir(join(path, '..'))).toEqual(['connection.json']);
  });

  it('never writes plaintext if encryption fails', async () => {
    const path = await storagePath();
    const protection = testProtection();
    const original = new EncryptedConnectionStore(path, protection);
    await original.write(saved);
    const before = await fs.readFile(path, 'utf8');
    const failing = new EncryptedConnectionStore(path, {
      ...protection, protect: () => { throw new Error(`do not expose ${saved.key}`); },
    });
    await expect(failing.write(saved)).rejects.toThrow('Windows encryption failed');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('reports corruption and account decryption errors, not first-run state', async () => {
    const path = await storagePath();
    const store = new EncryptedConnectionStore(path, testProtection());
    await fs.writeFile(path, '{invalid');
    await expect(store.read()).rejects.toThrow('corrupt');
    await store.write(saved);
    await expect(new EncryptedConnectionStore(path, testProtection()).read()).rejects.toThrow('cannot be decrypted');
  });

  it('accurately reports read and deletion failures without dropping the key', async () => {
    const path = await storagePath();
    const protection = testProtection();
    const original = new EncryptedConnectionStore(path, protection);
    await original.write(saved);
    const blocked = new EncryptedConnectionStore(path, protection, {
      ...fs, unlink: async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
    });
    await expect(blocked.forget()).rejects.toThrow('saved key is still present');
    expect(await original.read()).toEqual(saved);
    const unreadable = new EncryptedConnectionStore(path, protection, {
      ...fs, stat: async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
    });
    await expect(unreadable.read()).rejects.toThrow('could not be read');
  });
});

describe('secret-free settings service', () => {
  it('returns metadata without the key and freezes a separate operation snapshot', async () => {
    const store = new MemoryStore(saved);
    const service = new ConnectionService(store);
    const result = await service.public();
    expect(result.hasKey).toBe(true);
    expect(JSON.stringify(result)).not.toContain(saved.key);
    const snapshot = await service.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
    store.record = { ...saved, key: 'another-fake-key' };
    expect(snapshot.key).toBe(saved.key);
  });

  it('allows an explicit keep action for a model-only change', async () => {
    const store = new MemoryStore(saved);
    const service = new ConnectionService(store);
    await service.save({ settings: { ...settings, model: 'new-model' }, key: { action: 'keep' } });
    expect(store.record?.key).toBe(saved.key);
    expect(store.record?.settings.model).toBe('new-model');
    await expect(service.save({ settings, key: '********' })).rejects.toThrow('explicitly keep');
  });

  it('requires re-entering the key for URL/protocol changes', async () => {
    const service = new ConnectionService(new MemoryStore(saved));
    await expect(service.prepare({ settings: { ...settings, apiUrl: 'https://other.example/v1' }, key: { action: 'keep' } })).rejects.toThrow('re-entering');
    await expect(service.prepare({ settings: { ...settings, protocol: 'anthropic' }, key: { action: 'keep' } })).rejects.toThrow('re-entering');
    await expect(service.prepare({ settings, key: { action: 'replace', value: 'fake\ninvalid' } })).rejects.toThrow('control characters');
  });

  it('preparing a test draft never saves it', async () => {
    const store = new MemoryStore(saved);
    const service = new ConnectionService(store);
    const draft = await service.prepare({ settings: { ...settings, model: 'draft-model' }, key: { action: 'replace', value: 'draft-fake-key' } });
    expect(draft.settings.model).toBe('draft-model');
    expect(store.record).toEqual(saved);
  });
});
