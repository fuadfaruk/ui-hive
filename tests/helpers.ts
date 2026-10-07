import type { CredentialStore, SavedConnection } from '../server/connection.js';
import type { ConnectionSettings } from '../shared/types.js';

export const settings: ConnectionSettings = {
  protocol: 'openai', apiUrl: 'https://gateway.example/custom/v1',
  model: 'a-free-form-model/id', anthropicMaxTokens: 8192,
};

export const saved: SavedConnection = { settings, key: 'fake-unit-test-key-not-a-real-secret' };

export class MemoryStore implements CredentialStore {
  constructor(public record: SavedConnection | null = null) {}
  async read() { return structuredClone(this.record); }
  async write(record: SavedConnection) { this.record = structuredClone(record); }
  async forget() { this.record = null; }
}
