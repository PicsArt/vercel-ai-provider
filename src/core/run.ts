import { planBatches } from './batches';
import { PicsartInputError, PicsartModelError, PicsartValidationError } from './errors';
import { mapRequest } from './mapping';
import { buildPlaygroundUrl, DEFAULT_PLAYGROUND_URL } from './playground';
import type {
  CatalogModel,
  ExecutorResult,
  MediaCallResult,
  MediaExecutor,
  MediaItem,
  MediaOperation,
  MediaRequest,
  MediaStartResult,
  MediaStatus,
  MediaWarning,
  ModelCatalog,
} from './types';

export const DEFAULT_MAX_GENERATIONS_PER_CALL = 100;
export const DEFAULT_MAX_CONCURRENT_JOBS = 4;

export interface RunLimits {
  maxGenerations?: number;
  maxConcurrentJobs?: number;
}

export interface RunDependencies {
  catalog: ModelCatalog;
  executor: MediaExecutor;
  playgroundUrl?: string | false;
  limits?: RunLimits;
}

export const OPERATIONS_NEED_SDK = "Starting a Picsart job and checking it later needs execution: 'sdk' (the default).";

// the id lands unencoded in one path segment of an authenticated request
const PATH_CHANGING = /[/\\?#%\s\x00-\x1f\x7f]/;

// the URL parser turns a lone surrogate into U+FFFD, so the status read would be recorded under another key
export function isGenerationId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && value !== '.' && value !== '..' && !PATH_CHANGING.test(value) && value.isWellFormed();
}

interface PreparedMedia {
  model: CatalogModel;
  params: Record<string, unknown>;
  payloads: Array<Record<string, unknown>>;
  warnings: MediaWarning[];
}

async function catalogModel(catalog: ModelCatalog, modelId: string): Promise<CatalogModel> {
  const model = await catalog.getModel(modelId);
  if (!model) throw new PicsartModelError(modelId, `Unknown Picsart model "${modelId}". Call listModels() to see the available models.`);
  return model;
}

async function prepareMedia(deps: RunDependencies, request: MediaRequest): Promise<PreparedMedia> {
  const maxGenerations = deps.limits?.maxGenerations ?? DEFAULT_MAX_GENERATIONS_PER_CALL;
  if (request.n > maxGenerations) {
    throw new PicsartInputError('n', `n = ${request.n} is more than the ${maxGenerations} generations allowed in one call. Split the request into smaller calls, or raise maxGenerationsPerCall.`);
  }
  const model = await catalogModel(deps.catalog, request.modelId);
  if (model.mode !== request.kind) throw new PicsartModelError(request.modelId, `Picsart model "${model.id}" makes ${model.mode}, not ${request.kind}.`);

  const { params, warnings } = mapRequest(model, request);
  const countParam = model.params.count;
  const allowedCounts = countParam?.kind === 'enum' && countParam.options ? countParam.options.map((option) => Number(option.id)) : undefined;
  const plan = planBatches(request.n, allowedCounts);
  if (allowedCounts && params.count !== undefined && plan.some((count) => count !== Number(params.count))) {
    warnings.push({
      type: 'unsupported',
      feature: 'providerOptions.picsart.count',
      details: `count is planned from n: ${model.id} runs n = ${request.n} as batches of ${plan.join(', ')}, so count ${String(params.count)} was not sent. Set n instead.`,
    });
    delete params.count;
  }
  const payloads: Array<Record<string, unknown>> = plan.map((count) => (allowedCounts ? { ...params, count } : { ...params }));

  const validatedCounts = new Set<unknown>();
  for (const payload of payloads) {
    if (validatedCounts.has(payload.count)) continue;
    validatedCounts.add(payload.count);
    const result = deps.executor.validate(model.id, payload);
    if (result && !result.valid) throw new PicsartValidationError(model.id, result.errors ?? []);
  }
  return { model, params, payloads, warnings };
}

function playgroundLink(deps: RunDependencies, model: CatalogModel, params: Record<string, unknown>): string | undefined {
  return deps.playgroundUrl === false ? undefined : buildPlaygroundUrl(deps.playgroundUrl ?? DEFAULT_PLAYGROUND_URL, model.id, params);
}

function toItems(result: ExecutorResult, playgroundUrl: string | undefined): MediaItem[] {
  return result.items.map((item) => ({
    url: item.url,
    ...(result.generationId ? { generationId: result.generationId } : {}),
    ...(playgroundUrl ? { playgroundUrl } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
}

function toCallResult(results: ExecutorResult[], playgroundUrl: string | undefined, modelId: string, warnings: MediaWarning[]): MediaCallResult {
  const credits = results.some((result) => result.credits !== undefined)
    ? results.reduce((sum, result) => sum + (result.credits ?? 0), 0)
    : undefined;
  const balance = results.map((result) => result.balance).filter((value): value is number => value !== undefined).at(-1);
  return {
    items: results.flatMap((result) => toItems(result, playgroundUrl)),
    ...(credits !== undefined ? { credits } : {}),
    ...(balance !== undefined ? { balance } : {}),
    warnings,
    modelId,
  };
}

async function settleInOrder<T, R>(items: T[], concurrency: number, signal: AbortSignal | undefined, run: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const settled: Array<PromiseSettledResult<R>> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      if (signal?.aborted) {
        settled[index] = { status: 'rejected', reason: signal.reason };
        continue;
      }
      try {
        settled[index] = { status: 'fulfilled', value: await run(items[index]) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return settled;
}

export async function runMedia(deps: RunDependencies, request: MediaRequest, options: { signal?: AbortSignal } = {}): Promise<MediaCallResult> {
  const { model, params, payloads, warnings } = await prepareMedia(deps, request);

  const requested = deps.limits?.maxConcurrentJobs;
  const concurrency = requested !== undefined && Number.isInteger(requested) && requested >= 1 ? requested : DEFAULT_MAX_CONCURRENT_JOBS;
  const settled = await settleInOrder(payloads, concurrency, options.signal, async (payload) => deps.executor.generate(model.id, payload, { kind: request.kind, signal: options.signal }));
  const succeeded = settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
  const failed = settled.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason as unknown] : []));
  if (succeeded.length === 0) throw failed[0];
  if (failed.length > 0) {
    const reason = failed[0] instanceof Error ? failed[0].message : String(failed[0]);
    warnings.push({ type: 'other', message: `${failed.length} of ${payloads.length} Picsart jobs failed (${reason}). The results that succeeded are returned.` });
  }

  return toCallResult(succeeded, playgroundLink(deps, model, params), model.id, warnings);
}

export async function startMedia(deps: RunDependencies, request: MediaRequest, options: { signal?: AbortSignal } = {}): Promise<MediaStartResult> {
  const { executor } = deps;
  if (!executor.start) throw new PicsartInputError('execution', OPERATIONS_NEED_SDK);
  if (request.n !== 1) throw new PicsartInputError('n', `One start makes one result, but n is ${request.n}. Start each result separately.`);
  const { model, params, payloads, warnings } = await prepareMedia(deps, request);
  if (payloads.length !== 1) {
    throw new PicsartInputError('n', `One start runs one Picsart job, but n = ${request.n} needs ${payloads.length} jobs on "${model.id}". Start each job separately with a smaller n.`);
  }

  const { generationId } = await executor.start(model.id, payloads[0], { signal: options.signal });
  const playgroundUrl = playgroundLink(deps, model, params);
  return { operation: { modelId: request.modelId, generationId, ...(playgroundUrl ? { playgroundUrl } : {}) }, warnings };
}

export async function mediaStatus(deps: Pick<RunDependencies, 'catalog' | 'executor'>, operation: MediaOperation, options: { signal?: AbortSignal } = {}): Promise<MediaStatus> {
  const { executor } = deps;
  if (!executor.status) throw new PicsartInputError('execution', OPERATIONS_NEED_SDK);
  const model = await catalogModel(deps.catalog, operation.modelId);
  const checked = await executor.status(model.id, operation.generationId, { signal: options.signal });
  if (checked.state === 'pending') return { state: 'pending' };
  return { state: 'completed', result: toCallResult([{ ...checked.result, generationId: operation.generationId }], operation.playgroundUrl, model.id, []) };
}
