import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:3141';
const mock = 'http://127.0.0.1:4319';

async function configure(request: APIRequestContext, model = 'mock-good', protocol = 'openai') {
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  const response = await request.post('/api/connection', {
    headers: { Origin: origin, 'X-UI-Maker-Token': bootstrap.csrfToken },
    data: {
      settings: { protocol, apiUrl: `${mock}/v1`, model, anthropicMaxTokens: 8192 },
      key: { action: 'replace', value: 'fake-e2e-key' },
    },
  });
  expect(response.ok()).toBe(true);
}

async function generate(page: Page, prompt = 'Build a calm focus timer') {
  await page.getByLabel('Design prompt', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('.artifact-card')).toHaveCount(3);
}

async function ready(page: Page, count = 3) {
  await expect(page.locator('.artifact-card .status-complete')).toHaveCount(count);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
}

async function setModel(page: Page, model: string) {
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByLabel(/^Model ID/).fill(model);
  await page.getByRole('button', { name: 'Save Connection', exact: true }).click();
  await expect(page.getByText('Connection saved. Your studio is ready to generate.')).toBeVisible();
  await page.getByRole('button', { name: 'Close Connection settings', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await configure(request);
  expect((await request.post(`${mock}/_test/reset`)).ok()).toBe(true);
});

test('first run, explicit connection test, safe key retention, and forgetting', async ({ page, request }, info) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  await request.delete('/api/connection', { headers: { Origin: origin, 'X-UI-Maker-Token': bootstrap.csrfToken }, data: {} });
  await page.goto('/');
  await page.getByLabel('Design prompt', { exact: true }).fill('A new design');
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('empty-studio.png'), fullPage: true });
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByLabel('API URL', { exact: true }).fill(mock);
  await expect(page.getByText(/No API prefix was provided/)).toBeVisible();
  await expect(page.getByLabel('Resolved request URL')).toHaveText(`${mock}/chat/completions`);
  await page.getByLabel('API URL', { exact: true }).fill(`${mock}/v1`);
  await page.getByLabel(/^Model ID/).fill('mock-good');
  await page.getByLabel(/^API key/).fill('fake-e2e-key');
  await expect(page.getByLabel(/^API key/)).toHaveAttribute('type', 'password');
  await expect(page.getByText(/Provider charges can apply/)).toBeVisible();
  await page.getByRole('button', { name: 'Test Connection', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /responded successfully/ })).toBeVisible();
  expect((await (await request.get('/api/bootstrap')).json()).connection.hasKey).toBe(false);
  await page.getByRole('button', { name: 'Save Connection', exact: true }).click();
  await expect(page.getByText('Connection saved. Your studio is ready to generate.')).toBeVisible();
  await expect(page.getByLabel(/^API key/)).toHaveValue('');
  await page.getByLabel(/^Model ID/).fill('mock-truncated');
  await page.getByRole('button', { name: 'Save Connection', exact: true }).click();
  await expect(page.getByText('Connection saved. Your studio is ready to generate.')).toBeVisible();
  await page.getByLabel('API URL', { exact: true }).fill(`${mock}/different/v1`);
  await page.getByRole('button', { name: 'Save Connection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter an API key');
  expect((await (await request.get('/api/bootstrap')).json()).connection.settings.apiUrl).toBe(`${mock}/v1`);
  await page.getByRole('button', { name: 'Close Connection settings', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await expect(page.getByLabel(/^API key/)).toHaveValue('');
  await expect(page.getByLabel(/^Model ID/)).toHaveValue('mock-truncated');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('fake-e2e-key');
  expect(await page.content()).not.toContain('fake-e2e-key');
  await page.getByRole('button', { name: 'Forget Key', exact: true }).click();
  await expect(page.getByText('The saved connection and its key have been deleted.')).toBeVisible();
  expect((await (await request.get('/api/bootstrap')).json()).connection.hasKey).toBe(false);
  const stats = await (await request.get(`${mock}/_test/stats`)).json();
  expect(stats.tests).toBe(1);
  expect(stats.plans + stats.html + stats.ideas + stats.variations).toBe(0);
});

test('three streamed designs, isolated interactive focus, source, variations, deck navigation and reload', async ({ page, request, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto('/');
  await generate(page);
  await ready(page);
  await page.screenshot({ path: info.outputPath('comparison-deck.png'), fullPage: true });
  const stats = await (await request.get(`${mock}/_test/stats`)).json();
  expect(stats.plans).toBe(1);
  expect(stats.html).toBe(3);
  expect(stats.maxActive).toBe(3);
  await page.getByRole('button', { name: 'Focus Pressed Paper', exact: true }).click();
  const focus = page.getByRole('dialog', { name: 'Pressed Paper', exact: true });
  await expect(focus).toBeVisible();
  await expect(focus.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  const preview = focus.frameLocator('iframe');
  await preview.getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(preview.locator('#counter')).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(focus).not.toBeVisible();
  await page.getByRole('button', { name: 'Focus Pressed Paper', exact: true }).click();
  await expect(focus).toBeVisible();
  await expect(preview.locator('body')).toHaveAttribute('data-parent-blocked', 'true');
  await expect(preview.locator('body')).toHaveAttribute('data-fetch-blocked', 'true');
  expect(await page.locator('body').getAttribute('data-preview-escaped')).toBeNull();
  expect((await (await request.get(`${mock}/_test/stats`)).json()).leaks).toBe(0);
  const bounds = await focus.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath('focused-design.png') });
  await focus.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Source', exact: true });
  await expect(source.locator('pre')).toContainText('<script>');
  await expect(source.locator('pre script')).toHaveCount(0);
  await source.getByRole('button', { name: 'Copy source', exact: true }).click();
  await expect(source.getByRole('status')).toContainText('Source copied as plain text');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('UNTRUSTED GENERATED HTML');
  const downloading = page.waitForEvent('download');
  await source.getByRole('button', { name: 'Export HTML', exact: true }).click();
  const download = await downloading;
    expect(download.suggestedFilename()).toBe('uihive-pressed-paper.html');
  const exported = await readFile((await download.path())!, 'utf8');
  expect(exported).toContain('UNTRUSTED GENERATED HTML');
  expect(exported).toContain('<!doctype html>');
  expect(exported).not.toContain('fake-e2e-key');
  await page.keyboard.press('Escape');
  await expect(source).not.toBeVisible();
  await expect(focus.getByRole('button', { name: 'Source', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const second = page.getByRole('dialog', { name: 'Etched Alloy', exact: true });
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Previous design', exact: true }).click();
  await focus.getByRole('button', { name: 'Variations', exact: true }).click();
  const variations = page.getByRole('dialog', { name: 'Variations', exact: true });
  await expect(variations.getByRole('button', { name: 'Apply Recast Pressed Paper', exact: true })).toBeVisible();
  await expect(variations.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-scripts');
  await variations.getByRole('button', { name: 'Apply Recast Pressed Paper', exact: true }).click();
  await expect(variations).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Recast Pressed Paper', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Grid View', exact: true }).click();
  await expect(page.locator('.artifact-card')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await generate(page, 'Build a second calm workspace');
  await ready(page);
  await page.getByRole('button', { name: 'Previous deck', exact: true }).click();
  await expect(page.locator('.artifact-card')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Build a calm focus timer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next deck', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Build a second calm workspace', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.artifact-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Deck \d:/ })).toHaveCount(0);
  await page.getByLabel('Design prompt', { exact: true }).fill('Connection remains available');
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  expect((await (await request.get('/api/bootstrap')).json()).connection.hasKey).toBe(true);
});

test('Stop preserves partial source, labels incomplete exports, and permits a clean new operation', async ({ page, request }) => {
  await page.goto('/');
  await generate(page, 'A completed earlier deck');
  await ready(page);
  await setModel(page, 'mock-slow');
  await generate(page, 'A slow current deck');
  await expect(page.locator('.artifact-streaming iframe').first()).toBeAttached();
  await page.getByRole('button', { name: 'Previous deck', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A completed earlier deck', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await expect(page.locator('.artifact-card .status-complete')).toHaveCount(3);
  await page.getByRole('button', { name: 'Next deck', exact: true }).click();
  await expect(page.locator('.artifact-card .status-cancelled')).toHaveCount(3);
  await page.getByRole('button', { name: 'Focus Pressed Paper', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Variations', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Source', exact: true });
  await expect(source.getByText('Incomplete source.', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await source.getByRole('button', { name: 'Export HTML', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toContain('-incomplete.html');
  expect(await readFile((await download.path())!, 'utf8')).toContain('INCOMPLETE OUTPUT (cancelled)');
  await page.getByRole('button', { name: 'Close Source', exact: true }).click();
  await page.getByRole('button', { name: 'Grid View', exact: true }).click();
  await setModel(page, 'mock-good');
  await generate(page, 'A fresh design after stopping');
  await ready(page);
});

test('isolates a failing candidate and never reports token-limited source as complete', async ({ page, request }) => {
  await configure(request, 'mock-one-error');
  await page.goto('/');
  await generate(page);
  await ready(page, 2);
  await expect(page.locator('.artifact-card .status-error')).toHaveCount(1);
  expect(await page.locator('body').innerText()).not.toContain('fake-e2e-key');
  await setModel(page, 'mock-truncated');
  await generate(page, 'A token-limited design');
  await expect(page.locator('.artifact-card .status-incomplete')).toHaveCount(3);
  await expect(page.locator('.artifact-card .status-complete')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await setModel(page, 'mock-good');
  await generate(page, 'Recovery design');
  await ready(page);
});

test('Anthropic Messages supports the same local generation and interactive preview flow', async ({ page, request }) => {
  await configure(request, 'mock-good', 'anthropic');
  await page.goto('/');
  await generate(page, 'An Anthropic-compatible interface');
  await ready(page);
  await page.getByRole('button', { name: 'Focus Pressed Paper', exact: true }).click();
  const focus = page.getByRole('dialog', { name: 'Pressed Paper', exact: true });
  await focus.frameLocator('iframe').getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(focus.frameLocator('iframe').locator('#counter')).toHaveText('1');
  await focus.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Source', exact: true }).locator('pre')).toContainText('<!doctype html>');
});

test('prompt ideas are explicit, Surprise Me generates, and reduced motion respects keyboard focus', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Refresh Ideas', exact: true })).toBeEnabled();
  await page.waitForTimeout(1200);
  const initial = await (await request.get(`${mock}/_test/stats`)).json();
  expect(initial.plans + initial.html + initial.ideas + initial.variations + initial.tests).toBe(0);
  await page.getByRole('button', { name: 'Refresh Ideas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh Ideas', exact: true })).toBeEnabled();
  expect((await (await request.get(`${mock}/_test/stats`)).json()).ideas).toBe(1);
  await expect(page.getByRole('button', { name: /Use idea: Design a tactile/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Connection settings', exact: true });
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Tab');
    expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Connection settings', exact: true })).toBeFocused();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await page.getByRole('button', { name: 'Surprise Me', exact: true }).click();
  await ready(page);
  expect((await (await request.get(`${mock}/_test/stats`)).json()).plans).toBe(1);
});
