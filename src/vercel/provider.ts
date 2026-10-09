import { InvalidArgumentError, NoSuchModelError, type Experimental_VideoModelV4, type ImageModelV4, type ProviderV4 } from '@ai-sdk/provider';
import { loadApiKey, withoutTrailingSlash, withUserAgentSuffix, type FetchFunction } from '@ai-sdk/provider-utils';
import { createClient } from '@picsart/ai-sdk';
import { isModelCatalog, remoteCatalog, sdkCatalog } from '../core/catalog';
import { sdkExecutor, sdkValidate, serverExecutor, serverValidate } from '../core/executors';
import { DEFAULT_PLAYGROUND_URL } from '../core/playground';
import { recordStatusReads } from '../core/status-reads';
import type { CatalogModel, MediaKind, ModelCatalog } from '../core/types';
import { VERSION } from '../version';
import { toProviderError } from './errors';
import { PicsartImageModel } from './image-model';
import { lazyExecutor, type PicsartRuntime } from './runtime';
import { serializedConfig } from './serialization';
import { PicsartVideoModel } from './video-model';

export const DEFAULT_BASE_URL = 'https://api.picsart.com';

// @picsart/ai-sdk adds these itself only when it builds the fetch from an apiKey
const GATEWAY_HEADERS: Record<string, string> = { platform: 'api', 'X-Touchpoint': 'sdk' };

const CUSTOM_CATALOG_REFUSAL = "This model's provider uses a custom ModelCatalog object, which Workflow state cannot carry; a restored model would read its models from a different catalog. Use catalog: 'sdk' or catalog: { url, ttlMs } for models that cross Workflow steps.";

export interface PicsartProviderSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: FetchFunction;
  headers?: Record<string, string>;
  catalog?: 'sdk' | { url: string; ttlMs?: number } | ModelCatalog;
  execution?: 'sdk' | 'server';
  playgroundUrl?: string | false;
  maxGenerationsPerCall?: number;
  maxConcurrentJobs?: number;
}

function positiveWholeNumber(settings: PicsartProviderSettings, name: 'maxGenerationsPerCall' | 'maxConcurrentJobs'): number | undefined {
  const value = settings[name];
  if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
    throw new InvalidArgumentError({ argument: name, message: `${name} must be a positive whole number, got ${String(value)}.` });
  }
  return value;
}

export interface PicsartModelInfo {
  id: string;
  name: string;
  mode: MediaKind;
  inputType?: string;
  /** Required parameters other than `prompt`; empty when the prompt alone is enough. */
  requiredParams: string[];
}

function requiredParams(model: CatalogModel): string[] {
  return Object.entries(model.params).filter(([key, param]) => key !== 'prompt' && param.required).map(([key]) => key);
}

export interface PicsartProvider extends ProviderV4 {
  readonly catalog: ModelCatalog;
  image(modelId: string): ImageModelV4;
  imageModel(modelId: string): ImageModelV4;
  video(modelId: string): Experimental_VideoModelV4;
  videoModel(modelId: string): Experimental_VideoModelV4;
  listModels(filter?: { mode?: MediaKind }): Promise<PicsartModelInfo[]>;
}

export function createPicsartWith(runtime: PicsartRuntime): PicsartProvider {
  const image = (modelId: string): ImageModelV4 => new PicsartImageModel(modelId, runtime);
  const video = (modelId: string): Experimental_VideoModelV4 => new PicsartVideoModel(modelId, runtime);
  const noTextModels = (modelId: string, modelType: 'languageModel' | 'embeddingModel'): never => {
    throw new NoSuchModelError({ modelId, modelType, message: 'The Picsart provider offers image and video models.' });
  };
  return {
    specificationVersion: 'v4',
    catalog: runtime.catalog,
    image,
    imageModel: image,
    video,
    videoModel: video,
    languageModel: (modelId: string) => noTextModels(modelId, 'languageModel'),
    embeddingModel: (modelId: string) => noTextModels(modelId, 'embeddingModel'),
    async listModels(filter) {
      try {
        const models = await runtime.catalog.listModels(filter);
        return models.flatMap((model) => (model.mode === 'image' || model.mode === 'video'
          ? [{ id: model.id, name: model.name, mode: model.mode, ...(model.inputType ? { inputType: model.inputType } : {}), requiredParams: requiredParams(model) }]
          : []));
      } catch (error) {
        throw toProviderError(error, { modelId: '*', modelType: 'imageModel', url: runtime.baseURL });
      }
    },
  };
}

export function createPicsart(settings: PicsartProviderSettings = {}): PicsartProvider {
  const limits = { maxGenerations: positiveWholeNumber(settings, 'maxGenerationsPerCall'), maxConcurrentJobs: positiveWholeNumber(settings, 'maxConcurrentJobs') };
  const baseURL = withoutTrailingSlash(settings.baseURL) ?? DEFAULT_BASE_URL;
  const plainFetch: FetchFunction = settings.fetch ?? ((input, init) => fetch(input, init));
  const apiKey = (): string => loadApiKey({ apiKey: settings.apiKey, environmentVariableName: 'PICSART_API_KEY', description: 'Picsart' });
  const authorizedFetch = (key: () => string, callHeaders?: Record<string, string | undefined>) =>
    (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries({ ...settings.headers, ...callHeaders })) {
        if (value !== undefined) headers.set(name, value);
      }
      for (const [name, value] of Object.entries(GATEWAY_HEADERS)) {
        if (!headers.has(name)) headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${key()}`);
      return plainFetch(url, { ...init, headers: withUserAgentSuffix(headers, `picsart-vercel-ai-provider/${VERSION}`) });
    };

  const catalog = settings.catalog === undefined || settings.catalog === 'sdk'
    ? sdkCatalog()
    : isModelCatalog(settings.catalog)
      ? settings.catalog
      : remoteCatalog({ url: settings.catalog.url, ttlMs: settings.catalog.ttlMs, fetch: authorizedFetch(apiKey) });

  const asyncOperations = settings.execution !== 'server';
  const playgroundUrl = settings.playgroundUrl ?? DEFAULT_PLAYGROUND_URL;
  const config = serializedConfig(settings, { baseURL, execution: asyncOperations ? 'sdk' : 'server', playgroundUrl });
  return createPicsartWith({
    catalog,
    baseURL,
    fetch: plainFetch,
    playgroundUrl,
    asyncOperations,
    limits,
    serialized: {
      config: () => config,
      apiKey: () => settings.apiKey,
      ...(isModelCatalog(settings.catalog) ? { refusal: CUSTOM_CATALOG_REFUSAL } : {}),
    },
    executor: (callHeaders) => lazyExecutor(asyncOperations ? sdkValidate : serverValidate, () => {
      const key = apiKey();
      const picsartFetch = authorizedFetch(() => key, callHeaders);
      if (!asyncOperations) {
        const client = createClient({ apiUrl: baseURL, fetch: picsartFetch });
        return serverExecutor({ run: (api, payload, options) => client.apis.run(api, payload, options) });
      }
      const reads = recordStatusReads(picsartFetch);
      return sdkExecutor(createClient({ apiUrl: baseURL, fetch: reads.fetch }), { readOutcome: reads.log });
    }, asyncOperations),
  });
}
