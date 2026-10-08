import { getModel, getModelsByMode, Model, type FlatParamEntry } from '@picsart/ai-sdk';
import { PicsartCatalogError } from './errors';
import { MEDIA_KINDS, type CatalogModel, type CatalogParam, type ModelCatalog } from './types';

export const DEFAULT_CATALOG_TTL_MS = 10 * 60 * 1000;

function toCatalogParam(entry: FlatParamEntry): CatalogParam {
  const param: CatalogParam = { kind: entry.kind as CatalogParam['kind'], required: entry.required === true };
  if (entry.kind === 'enum') param.options = entry.options.map((option) => ({ id: option.id }));
  if (entry.kind === 'range') {
    param.min = entry.min;
    param.max = entry.max;
    if (entry.step !== undefined) param.step = entry.step;
  }
  if (entry.kind === 'file') {
    param.accept = entry.accept;
    if (entry.array) param.array = { ...entry.array };
  }
  return param;
}

function sdkModel(id: string): CatalogModel | undefined {
  const definition = getModel(id);
  if (!definition) return undefined;
  const params = Object.fromEntries(Model(definition.id).params().all().map((entry) => [entry.key, toCatalogParam(entry)]));
  return { id: definition.id, name: definition.name, mode: definition.mode, inputType: definition.inputType, params };
}

export function isModelCatalog(value: unknown): value is ModelCatalog {
  return typeof value === 'object' && value !== null
    && typeof (value as ModelCatalog).getModel === 'function'
    && typeof (value as ModelCatalog).listModels === 'function';
}

export function sdkCatalog(): ModelCatalog {
  return {
    async getModel(id) {
      return sdkModel(id);
    },
    async listModels(filter) {
      const modes = filter?.mode ? [filter.mode] : MEDIA_KINDS;
      return modes.flatMap((mode) => getModelsByMode(mode).flatMap((definition) => {
        const model = sdkModel(definition.id);
        return model ? [model] : [];
      }));
    },
  };
}

export interface RemoteCatalogOptions {
  url: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  ttlMs?: number;
  now?: () => number;
}

interface RemoteParam {
  kind: CatalogParam['kind'];
  required?: boolean;
  options?: Array<{ id: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  accept?: CatalogParam['accept'];
  array?: { min?: number; max?: number };
}

interface RemoteModel {
  id: string;
  name?: string;
  mode: string;
  inputType?: string;
  params?: Record<string, RemoteParam>;
}

interface RemoteResponse<T> {
  status?: string;
  response?: T;
  message?: string;
}

function normalizeRemoteModel(model: RemoteModel): CatalogModel {
  const params: Record<string, CatalogParam> = {};
  for (const [key, value] of Object.entries(model.params ?? {})) {
    const param: CatalogParam = { kind: value.kind, required: value.required === true };
    if (value.options) param.options = value.options.map((option) => ({ id: option.id }));
    if (value.min !== undefined) param.min = value.min;
    if (value.max !== undefined) param.max = value.max;
    if (value.step !== undefined) param.step = value.step;
    if (value.accept !== undefined) param.accept = value.accept;
    if (value.array) param.array = { ...value.array };
    params[key] = param;
  }
  const normalized: CatalogModel = { id: model.id, name: model.name ?? model.id, mode: model.mode, params };
  if (model.inputType !== undefined) normalized.inputType = model.inputType;
  return normalized;
}

export function remoteCatalog(options: RemoteCatalogOptions): ModelCatalog {
  const base = options.url.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();

  const get = <T>(path: string, whenMissing: 'undefined' | 'throw'): Promise<T | undefined> => {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T | undefined>;
    const url = `${base}${path}`;
    const value = (async () => {
      const response = await fetchFn(url, { method: 'GET' });
      if (response.status === 404) {
        if (whenMissing === 'undefined') return undefined;
        throw new PicsartCatalogError(url, 404, `The Picsart model catalog route was not found at ${url}. Check the catalog url.`);
      }
      const body = (await response.json().catch(() => undefined)) as RemoteResponse<T> | undefined;
      if (!response.ok || body?.status !== 'success') {
        const detail = body?.message ? `: ${body.message}` : '';
        throw new PicsartCatalogError(url, response.status, `Picsart model catalog request failed with HTTP ${response.status}${detail}`);
      }
      return body.response;
    })();
    cache.set(path, { at: now(), value });
    value.catch(() => cache.delete(path));
    return value;
  };

  return {
    async getModel(id) {
      const model = await get<RemoteModel>(`/v1/models-catalog/${encodeURIComponent(id)}`, 'undefined');
      return model ? normalizeRemoteModel(model) : undefined;
    },
    async listModels(filter) {
      const modes = filter?.mode ? [filter.mode] : MEDIA_KINDS;
      const result = await get<{ models: RemoteModel[] }>(`/v1/models-catalog?mode=${modes.join(',')}&include=schema`, 'throw');
      return (result?.models ?? []).map(normalizeRemoteModel);
    },
  };
}
