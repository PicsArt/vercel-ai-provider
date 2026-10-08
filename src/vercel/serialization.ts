import { SerializationError, serializeModelOptions } from '@ai-sdk/provider-utils';
import { isModelCatalog } from '../core/catalog';
import type { PicsartProviderSettings } from './provider';
import type { PicsartRuntime, PicsartSerializedConfig } from './runtime';

export { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@ai-sdk/provider-utils';

const CREDENTIAL_NAME = /auth|token|key|secret|cookie|session|password|credential|signature|jwt/;
const CREDENTIAL_VALUE = /^\s*(?:bearer|basic)\s/i;

function carriesCredential(name: string, value: string, keys: Array<string | undefined>): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase())
    || CREDENTIAL_VALUE.test(value)
    || keys.some((key) => key !== undefined && key !== '' && value.includes(key));
}

function stringHeaders(headers: PicsartProviderSettings['headers']): Pick<PicsartSerializedConfig, 'headers'> {
  const strings = Object.entries(headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return strings.length > 0 ? { headers: Object.fromEntries(strings) } : {};
}

function serializableCatalog(catalog: PicsartProviderSettings['catalog']): Pick<PicsartSerializedConfig, 'catalog'> {
  if (catalog === undefined || catalog === 'sdk') return { catalog: 'sdk' };
  if (isModelCatalog(catalog)) return {};
  return { catalog: { url: catalog.url, ...(catalog.ttlMs !== undefined ? { ttlMs: catalog.ttlMs } : {}) } };
}

function serializableLimits(settings: PicsartProviderSettings): Pick<PicsartSerializedConfig, 'maxGenerationsPerCall' | 'maxConcurrentJobs'> {
  return {
    ...(settings.maxGenerationsPerCall !== undefined ? { maxGenerationsPerCall: settings.maxGenerationsPerCall } : {}),
    ...(settings.maxConcurrentJobs !== undefined ? { maxConcurrentJobs: settings.maxConcurrentJobs } : {}),
  };
}

export function serializedConfig(settings: PicsartProviderSettings, resolved: Pick<PicsartSerializedConfig, 'baseURL' | 'execution' | 'playgroundUrl'>): PicsartSerializedConfig {
  return { ...resolved, ...stringHeaders(settings.headers), ...serializableCatalog(settings.catalog), ...serializableLimits(settings) };
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function containsKey(value: string, keys: Array<string | undefined>): boolean {
  return keys.some((key) => key !== undefined && key !== '' && (value.includes(key) || decoded(value).includes(key)));
}

function hasUserinfo(url: string): boolean {
  try {
    const { username, password } = new URL(url);
    return username !== '' || password !== '';
  } catch {
    return false;
  }
}

function hasCredentialParameter(url: string, keys: Array<string | undefined>): boolean {
  try {
    const { searchParams, hash } = new URL(url);
    const parameters = [...searchParams, ...new URLSearchParams(hash.slice(1))];
    return parameters.some(([name, value]) => carriesCredential(name, value, keys));
  } catch {
    return false;
  }
}

function assertNoUrlCredentials(config: Omit<PicsartSerializedConfig, 'headers'>, keys: Array<string | undefined>): void {
  const urls: Array<[string, string | undefined]> = [
    ['baseURL', config.baseURL],
    ['catalog.url', typeof config.catalog === 'object' ? config.catalog.url : undefined],
    ['playgroundUrl', config.playgroundUrl === false ? undefined : config.playgroundUrl],
  ];
  for (const [setting, url] of urls) {
    if (url !== undefined && (hasUserinfo(url) || hasCredentialParameter(url, keys) || containsKey(url, keys))) {
      throw new SerializationError({
        message: `${setting} carries credentials (a user name, a password, a credential query or fragment parameter, or the API key), and Workflow state must not hold them. Pass the key as apiKey or PICSART_API_KEY instead.`,
      });
    }
  }
}

export function serializeModel(modelId: string, runtime: PicsartRuntime) {
  if (!runtime.serialized) {
    throw new SerializationError({ message: 'Only models created with createPicsart can be serialized for a Workflow. Create this model with createPicsart instead of createPicsartWith.' });
  }
  if (runtime.serialized.refusal) throw new SerializationError({ message: runtime.serialized.refusal });
  const { headers, ...config } = runtime.serialized.config();
  const keys = [runtime.serialized.apiKey(), typeof process === 'undefined' ? undefined : process.env.PICSART_API_KEY];
  assertNoUrlCredentials(config, keys);
  const kept = Object.entries(headers ?? {}).filter(([name, value]) => !carriesCredential(name, value, keys));
  return serializeModelOptions({ modelId, config: { ...config, ...(kept.length > 0 ? { headers: Object.fromEntries(kept) } : {}) } });
}
