import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saved } from './helpers.js';

it.skipIf(process.platform !== 'win32')('uses real CurrentUser DPAPI across separate Node processes without plaintext files or output', async () => {
  const directory = await mkdtemp(join(process.env.LOCALAPPDATA!, 'UI-Maker-validation-'));
  const path = join(directory, 'connection.json');
  try {
    for (const action of ['write', 'read', 'replace', 'read-replacement', 'forget']) {
      const result = await promisify(execFile)(process.execPath, [
        '--import', 'tsx', fileURLToPath(new URL('./dpapi-worker.ts', import.meta.url)), path, action,
      ], { timeout: 15000, windowsHide: true });
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(saved.key);
      expect(result.stdout).toContain('passed');
      if (action !== 'forget') {
        const encoded = await readFile(path, 'utf8');
        expect(encoded).not.toContain(saved.key);
        expect(encoded).not.toContain('fake-dpapi-replacement');
        expect(encoded).not.toContain(saved.settings.apiUrl);
        expect(JSON.parse(encoded).version).toBe(1);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
