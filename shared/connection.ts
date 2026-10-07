import type { ConnectionSettings, Protocol } from './types.js';

export function resolveRequestUrl(protocol: Protocol, input: string): string {
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new Error('Choose OpenAI-compatible or Anthropic-compatible.');
  }
  if (typeof input !== 'string' || input.length > 2048) {
    throw new Error('Enter an API URL of at most 2048 characters.');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a complete API URL, including https:// and its API prefix.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP with an explicit loopback destination.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('API URLs cannot contain credentials, query strings, or fragments.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const operation = protocol === 'openai' ? '/chat/completions' : '/messages';
  const other = protocol === 'openai' ? '/messages' : '/chat/completions';
  if (path.endsWith(other)) {
    throw new Error('This URL ends in the other protocol\'s operation. Change the URL or protocol.');
  }
  url.pathname = path.endsWith(operation) ? path : path + operation;
  return url.toString();
}

export function connectionUrlHint(protocol: Protocol, input: string): string {
  const resolved = new URL(resolveRequestUrl(protocol, input));
  if (resolved.pathname === '/messages' || resolved.pathname === '/chat/completions') {
    return 'No API prefix was provided. If your provider needs /v1, include it in the URL; it is not added automatically.';
  }
  return 'Custom API prefixes are preserved. The operation path is appended only once.';
}

export function validateSettings(input: unknown): ConnectionSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Connection settings are required.');
  }
  const value = input as Record<string, unknown>;
  if (value.protocol !== 'openai' && value.protocol !== 'anthropic') {
    throw new Error('Choose a supported API protocol.');
  }
  if (typeof value.apiUrl !== 'string') throw new Error('An API URL is required.');
  resolveRequestUrl(value.protocol, value.apiUrl);
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\u0000-\u001f\u007f]/.test(value.model)) {
    throw new Error('Enter a model ID of 1 to 200 characters without control characters.');
  }
  const tokens = value.anthropicMaxTokens ?? 8192;
  if (!Number.isInteger(tokens) || (tokens as number) < 1 || (tokens as number) > 262144) {
    throw new Error('The Anthropic output limit must be a positive integer, at most 262144.');
  }
  const settings: ConnectionSettings = {
    protocol: value.protocol,
    apiUrl: value.apiUrl.trim(),
    model: value.model.trim(),
    anthropicMaxTokens: tokens as number,
  };
  if (value.openaiTokenLimit !== undefined && value.openaiTokenLimit !== null) {
    const limit = value.openaiTokenLimit as Record<string, unknown>;
    if (!limit || (limit.field !== 'max_tokens' && limit.field !== 'max_completion_tokens') ||
      !Number.isInteger(limit.value) || (limit.value as number) < 1 || (limit.value as number) > 262144) {
      throw new Error('Choose an OpenAI token-limit field and a positive integer, at most 262144.');
    }
    settings.openaiTokenLimit = { field: limit.field, value: limit.value as number };
  }
  const timeouts: Array<['firstByteTimeoutMs' | 'inactivityTimeoutMs', string]> = [
    ['firstByteTimeoutMs', 'The first-byte timeout'],
    ['inactivityTimeoutMs', 'The inactivity timeout'],
  ];
  for (const [field, label] of timeouts) {
    const timeout = value[field];
    if (timeout === undefined || timeout === null) continue;
    if (!Number.isInteger(timeout) || (timeout as number) < 1000 || (timeout as number) > 1_800_000) {
      throw new Error(`${label} must be a whole number of milliseconds between 1000 and 1800000.`);
    }
    settings[field] = timeout as number;
  }
  return settings;
}
