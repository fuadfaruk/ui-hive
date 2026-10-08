import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunLog } from '../server/runlog.js';
import { registerSecret } from '../shared/diagnostics.js';

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'uihive-runlog-'));
  directories.push(directory);
  return directory;
}

async function only(directory: string): Promise<string> {
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/\.jsonl$/);
  return join(directory, files[0]);
}

async function records(directory: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(await only(directory), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('run log file sink', () => {
  it('writes meta, exchange, failure, and finish records in order', async () => {
    const directory = await tempDir();
    const logger = createRunLog({ operationId: 'op-1', kind: 'generate', directory });
    logger.meta({
      protocol: 'openai', model: 'vendor/model', resolvedUrl: 'https://example.invalid/v1/chat/completions',
      sessionId: 'session-1', artifactIds: ['a', 'b', 'c'], prompt: 'Build a timer', promptChars: 13,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    logger.exchange({ phase: 'generate', label: 'Paper', artifactId: 'a', system: 'system rules', user: 'user input', output: '<html>ok</html>', finishReason: 'stop', reasoning: true, deltas: 7, endReason: 'done', maxTokens: 16384, temperature: 0.2 });
    logger.failure({ phase: 'generate', label: 'Paper', artifactId: 'a', site: 'artifact-invalid', severity: 'error', status: 'error', message: 'bad html', raw: 'nope', finishReason: 'length', reasoning: false, deltas: 2, endReason: 'finish_reason', maxTokens: 1024, temperature: 0 });
    logger.finish({ status: 'incomplete', elapsedMs: 1234 });
    await logger.close();
    const lines = await records(directory);
    expect(lines.map((line) => line.type)).toEqual(['meta', 'exchange', 'failure', 'finish']);
    expect(lines[0]).toMatchObject({ operationId: 'op-1', kind: 'generate', protocol: 'openai', artifactIds: ['a', 'b', 'c'], promptChars: 13 });
    expect(lines[1]).toMatchObject({ phase: 'generate', label: 'Paper', artifactId: 'a', system: 'system rules', user: 'user input', output: '<html>ok</html>', outputChars: 15, finishReason: 'stop', reasoning: true, deltas: 7, endReason: 'done', maxTokens: 16384, temperature: 0.2 });
    expect(lines[2]).toMatchObject({ site: 'artifact-invalid', severity: 'error', status: 'error', message: 'bad html', raw: 'nope', rawChars: 4, finishReason: 'length', reasoning: false, deltas: 2, endReason: 'finish_reason', maxTokens: 1024, temperature: 0 });
    expect(lines[3]).toMatchObject({ status: 'incomplete', elapsedMs: 1234 });
    for (const line of lines) expect(typeof line.ts).toBe('string');
  });

  it('redacts registered credentials from every logged field', async () => {
    const secret = 'sk-runlog-secret-value';
    registerSecret(secret);
    const directory = await tempDir();
    const logger = createRunLog({ operationId: 'op-2', kind: 'variations', directory });
    logger.exchange({ phase: 'variations', label: `label ${secret}`, system: `system ${secret}`, user: `user ${secret}`, output: `output ${secret}` });
    logger.failure({ phase: 'variations', label: 'variations', site: 'variations-count', severity: 'warning', status: 'incomplete', message: `message ${secret}`, raw: `raw ${secret}`, finishReason: `stop ${secret}`, endReason: `done ${secret}`, maxTokens: 16384, temperature: 0.2 });
    await logger.close();
    const content = await readFile(await only(directory), 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('[redacted]');
  });

  it('clips an oversized field with a head+tail marker while keeping the full length', async () => {
    const directory = await tempDir();
    const logger = createRunLog({ operationId: 'op-3', kind: 'generate', directory });
    const output = `${'A'.repeat(300_000)}TAIL-MARKER`;
    logger.exchange({ phase: 'generate', label: 'x', system: 's', user: 'u', output });
    await logger.close();
    const [line] = await records(directory);
    const text = String(line.output);
    expect(line.truncated).toBe(true);
    expect(line.outputChars).toBe(output.length);
    expect(text.startsWith('A'.repeat(1000))).toBe(true);
    expect(text.endsWith('TAIL-MARKER')).toBe(true);
    expect(text).toContain('chars omitted');
    expect(text.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('swallows filesystem failures instead of rejecting into the pipeline', async () => {
    const base = await tempDir();
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory');
    const logger = createRunLog({ operationId: 'op-4', kind: 'ideas', directory: join(blocker, 'logs') });
    expect(() => logger.meta({
      protocol: 'openai', model: 'm', resolvedUrl: 'https://example.invalid/v1/chat/completions',
      promptChars: 0, startedAt: new Date().toISOString(),
    })).not.toThrow();
    expect(() => logger.finish({ status: 'error', elapsedMs: 1 })).not.toThrow();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
