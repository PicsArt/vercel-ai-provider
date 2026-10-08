import type { FetchFunction } from '@ai-sdk/provider-utils';
import { PicsartInputError } from '../core/errors';
import { OPERATIONS_NEED_SDK, type RunLimits } from '../core/run';
import type { CatalogModel, MediaExecutor, ModelCatalog } from '../core/types';
import { toProviderError, type ErrorContext } from './errors';

export interface PicsartSerializedConfig {
  baseURL: string;
  headers?: Record<string, string>;
  catalog?: 'sdk' | { url: string; ttlMs?: number };
  execution: 'sdk' | 'server';
  playgroundUrl: string | false;
  maxGenerationsPerCall?: number;
  maxConcurrentJobs?: number;
}

export interface PicsartSerializable {
  config: () => PicsartSerializedConfig;
  apiKey: () => string | undefined;
  refusal?: string;
}

export interface PicsartRuntime {
  catalog: ModelCatalog;
  executor: (headers: Record<string, string | undefined> | undefined) => MediaExecutor;
  fetch: FetchFunction;
  baseURL: string;
  playgroundUrl: string | false;
  asyncOperations?: boolean;
  limits?: RunLimits;
  serialized?: PicsartSerializable;
}

export async function catalogModel(runtime: PicsartRuntime, modelId: string, modelType: ErrorContext['modelType'] = 'imageModel'): Promise<CatalogModel | undefined> {
  try {
    return await runtime.catalog.getModel(modelId);
  } catch (error) {
    throw toProviderError(error, { modelId, modelType, url: runtime.baseURL });
  }
}

export function lazyExecutor(validate: MediaExecutor['validate'], create: () => MediaExecutor, operations = false): MediaExecutor {
  let executor: MediaExecutor | undefined;
  const target = (): MediaExecutor => (executor ??= create());
  const lazy: MediaExecutor = {
    validate,
    async generate(modelId, params, options) {
      return target().generate(modelId, params, options);
    },
  };
  if (!operations) return lazy;
  return {
    ...lazy,
    async start(modelId, params, options) {
      const created = target();
      if (!created.start) throw new PicsartInputError('execution', OPERATIONS_NEED_SDK);
      return created.start(modelId, params, options);
    },
    async status(modelId, generationId, options) {
      const created = target();
      if (!created.status) throw new PicsartInputError('execution', OPERATIONS_NEED_SDK);
      return created.status(modelId, generationId, options);
    },
  };
}
