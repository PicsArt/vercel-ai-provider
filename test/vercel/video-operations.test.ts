import { APICallError, InvalidArgumentError, LoadAPIKeyError, NoSuchModelError, type JSONValue } from '@ai-sdk/provider';
import { ALL_MODELS, ApiError, getModel, type ApiErrorCode } from '@picsart/ai-sdk';
import { experimental_generateVideo, experimental_getVideoStatus, experimental_startVideo, RetryError, type GetVideoStatusResult } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { PicsartCatalogError, PicsartJobFailedError } from '../../src/core/errors';
import type { ExecutorStatus, MediaExecutor, ModelCatalog } from '../../src/core/types';
import type { PicsartVideoMetadata } from '../../src';
import { createPicsart, createPicsartWith } from '../../src/vercel/provider';
import type { PicsartRuntime } from '../../src/vercel/runtime';
import { testCatalog, videoListModel, videoModel } from '../fixtures/catalog';
import { fakeExecutor } from '../fixtures/executor';

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);

function runtimeWith(executor: MediaExecutor): PicsartRuntime {
  return {
    catalog: testCatalog,
    executor: () => executor,
    fetch: async () => new Response(MP4),
    baseURL: 'https://api.test',
    playgroundUrl: 'https://playground.test/',
  };
}

const videoOf = (executor: MediaExecutor) => createPicsartWith({ ...runtimeWith(executor), asyncOperations: true }).video(videoModel.id);

const finished = async (): Promise<ExecutorStatus> => ({
  state: 'completed',
  result: { items: [{ url: 'https://cdn.test/out.mp4', metadata: { lastFrameUrl: 'https://cdn.test/last-frame.png' } }], generationId: 'job-1', credits: 30, balance: 470 },
});

const stored = (operation: JSONValue): JSONValue => JSON.parse(JSON.stringify(operation)) as JSONValue;

type Completed = Extract<GetVideoStatusResult, { status: 'completed' }>;

describe('Picsart video operations', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  it('starts one job and returns an operation that survives JSON', async () => {
    const { calls, starts, executor } = fakeExecutor();
    const started = await experimental_startVideo({ model: videoOf(executor), prompt: { image: 'https://cdn.test/first.png', text: 'steam rises' }, duration: 5, fps: 60 });
    expect(starts).toHaveLength(1);
    expect(starts[0].params).toEqual({ prompt: 'steam rises', duration: 5, startFrame: 'https://cdn.test/first.png' });
    expect(calls).toHaveLength(0);
    expect(started.operation).toEqual({ modelId: videoModel.id, generationId: 'job-1', playgroundUrl: expect.stringMatching(/^https:\/\/playground\.test\/\?aistate=/) });
    expect(stored(started.operation)).toEqual(started.operation);
    expect(started.providerMetadata?.picsart).toEqual({ generationId: 'job-1', playgroundUrl: (started.operation as { playgroundUrl: string }).playgroundUrl });
    expect(started.warnings).toContainEqual(expect.objectContaining({ type: 'unsupported', feature: 'fps' }));
    expect(started.response).toMatchObject({ modelId: videoModel.id, headers: undefined });
  });

  it('warns that Picsart sends no webhook', async () => {
    const { starts, executor } = fakeExecutor();
    const started = await experimental_startVideo({ model: videoOf(executor), prompt: 'steam', webhookUrl: 'https://hooks.test/video' });
    expect(started.warnings).toContainEqual(expect.objectContaining({ type: 'unsupported', feature: 'webhookUrl' }));
    expect(starts).toHaveLength(1);
  });

  it('reports a running job as pending', async () => {
    const { statusCalls, executor } = fakeExecutor();
    const { operation } = await experimental_startVideo({ model: videoOf(executor), prompt: 'steam' });
    const status = await experimental_getVideoStatus(videoOf(executor), { operation: stored(operation) });
    expect(status).toEqual({ status: 'pending', response: expect.objectContaining({ modelId: videoModel.id }) });
    expect(statusCalls.map((call) => [call.modelId, call.generationId])).toEqual([[videoModel.id, 'job-1']]);
  });

  it('returns the finished video with its Picsart metadata', async () => {
    const { executor } = fakeExecutor({ status: finished });
    const { operation } = await experimental_startVideo({ model: videoOf(executor), prompt: 'steam' });
    const status = await experimental_getVideoStatus(videoOf(executor), { operation: stored(operation) }) as Completed;
    expect(status.status).toBe('completed');
    expect(status.videos).toEqual([{ type: 'url', url: 'https://cdn.test/out.mp4', mediaType: 'application/octet-stream' }]);
    expect(status.warnings).toEqual([]);
    expect(status.providerMetadata?.picsart).toEqual({
      videos: [{
        url: 'https://cdn.test/out.mp4',
        generationId: 'job-1',
        playgroundUrl: (operation as { playgroundUrl: string }).playgroundUrl,
        metadata: { lastFrameUrl: 'https://cdn.test/last-frame.png' },
        credits: 30,
      }],
      credits: 30,
      balance: 470,
    });
  });

  it('reports a job Picsart failed as an error status', async () => {
    const { statusCalls, executor } = fakeExecutor({
      status: async (call) => { throw new PicsartJobFailedError(call.modelId, call.generationId, 'content policy'); },
    });
    const status = await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1' } });
    expect(status).toEqual({ status: 'error', error: 'content policy', response: expect.objectContaining({ modelId: videoModel.id }) });
    expect(statusCalls).toHaveLength(1);
  });

  it('throws a read Picsart refused instead of reporting a failed job', async () => {
    for (const [httpStatus, code] of [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [422, 'unprocessable_entity']] as const) {
      const { executor } = fakeExecutor({ status: async () => { throw new ApiError('refused', { status: httpStatus, code: code as ApiErrorCode }); } });
      const error = await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1' }, maxRetries: 2 }).catch((e: unknown) => e);
      expect(APICallError.isInstance(error)).toBe(true);
      expect(error).toMatchObject({ isRetryable: false, statusCode: httpStatus, data: { code } });
    }
  });

  it('retries a status read that failed for a transient reason', async () => {
    vi.useFakeTimers();
    try {
      const { statusCalls, executor } = fakeExecutor({ status: async () => { throw new ApiError('Service unavailable', { status: 503, code: 'service_unavailable' as ApiErrorCode }); } });
      const pending = experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1' }, maxRetries: 2 }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(RetryError.isInstance(error)).toBe(true);
      expect(statusCalls).toHaveLength(3);
      const last = (error as RetryError).lastError;
      expect(APICallError.isInstance(last)).toBe(true);
      expect(last).toMatchObject({ isRetryable: true, statusCode: 503, data: { code: 'service_unavailable' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats rate limits, server errors and connection failures as transient', async () => {
    const failures: unknown[] = [
      new ApiError('Too many requests', { status: 429, code: 'rate_limited' }),
      new ApiError('fetch failed', { status: 502, code: 'connection_error' as ApiErrorCode }),
      new TypeError('fetch failed'),
      new ApiError('Non json response was returned from server', { status: 200, code: 'invalid_response' }),
    ];
    const { executor } = fakeExecutor({ status: async (_call, index) => { throw failures[index - 1]; } });
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < failures.length; attempt += 1) {
      errors.push(await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1' }, maxRetries: 0 }).catch((e: unknown) => e));
    }
    expect(errors.every((error) => APICallError.isInstance(error) && error.isRetryable)).toBe(true);
    expect(errors.map((error) => (error as APICallError).statusCode)).toEqual([429, 502, undefined, 200]);
    expect((errors[0] as APICallError).data).toEqual({ code: 'rate_limited', picsart: { generationId: 'job-1' } });
  });

  it('puts the generation id on every status read error', async () => {
    const failures: unknown[] = [
      new ApiError('Service unavailable', { status: 503, code: 'service_unavailable' }),
      new ApiError('refused', { status: 404, code: 'not_found' as ApiErrorCode }),
      new TypeError('fetch failed'),
      new APICallError({ message: 'proxy refused', url: 'https://proxy.test', requestBodyValues: {}, statusCode: 502, data: { proxy: 'edge-1' } }),
    ];
    const { executor } = fakeExecutor({ status: async (_call, index) => { throw failures[index - 1]; } });
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < failures.length; attempt += 1) {
      errors.push(await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-xyz' }, maxRetries: 0 }).catch((e: unknown) => e));
    }
    expect(errors.every((error) => APICallError.isInstance(error))).toBe(true);
    expect(errors.map((error) => (error as APICallError).data)).toEqual([
      { code: 'service_unavailable', picsart: { generationId: 'job-xyz' } },
      { code: 'not_found', picsart: { generationId: 'job-xyz' } },
      { picsart: { generationId: 'job-xyz' } },
      { proxy: 'edge-1', picsart: { generationId: 'job-xyz' } },
    ]);
    expect(errors.map((error) => (error as APICallError).isRetryable)).toEqual([true, false, true, true]);
  });

  it('never retries a failed start', async () => {
    const { starts, executor } = fakeExecutor({ start: async () => { throw new ApiError('Service unavailable', { status: 503, code: 'service_unavailable' as ApiErrorCode }); } });
    const error = await experimental_startVideo({ model: videoOf(executor), prompt: 'steam', maxRetries: 2 }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false, statusCode: 503 });
    expect(starts).toHaveLength(1);
  });

  it('lets generateVideo poll the job to completion', async () => {
    const downloads: string[] = [];
    const { calls, starts, statusCalls, executor } = fakeExecutor({ status: async (call, index) => (index === 1 ? { state: 'pending' } : finished()) });
    const result = await experimental_generateVideo({
      model: videoOf(executor),
      prompt: 'steam',
      poll: { intervalMs: 1, timeoutMs: 1000 },
      download: async ({ url }) => {
        downloads.push(String(url));
        return { data: MP4, mediaType: 'video/mp4' };
      },
    });
    expect(starts).toHaveLength(1);
    expect(statusCalls).toHaveLength(2);
    expect(calls).toHaveLength(0);
    expect(downloads).toEqual(['https://cdn.test/out.mp4']);
    expect(result.video.uint8Array).toEqual(MP4);
    expect(result.providerMetadata.picsart).toMatchObject({ generationId: 'job-1', videos: [expect.objectContaining({ url: 'https://cdn.test/out.mp4', credits: 30 })] });
    const metadata = result.providerMetadata.picsart as PicsartVideoMetadata;
    expect([metadata.generationId, metadata.credits, metadata.balance, metadata.videos[0].credits]).toEqual(['job-1', 30, 470, 30]);
  });

  it('rejects a direct start of more than one video', async () => {
    const { starts, executor } = fakeExecutor();
    const model = videoOf(executor);
    const error = await model.doStart!({
      prompt: 'steam', n: 2, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined,
      image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: undefined, providerOptions: {},
    }).then(() => undefined, (e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('n');
    expect(starts).toHaveLength(0);
  });

  it('rejects an operation that is garbled or belongs to another model', async () => {
    const { statusCalls, executor } = fakeExecutor({ status: finished });
    const operations: JSONValue[] = [
      null,
      'job-1',
      [],
      {},
      { modelId: videoModel.id },
      { modelId: videoModel.id, generationId: '' },
      { modelId: videoModel.id, generationId: 7 },
      { modelId: videoModel.id, generationId: 'job/1' },
      { modelId: videoModel.id, generationId: 'job?x=1' },
      { modelId: videoModel.id, generationId: '.' },
      { modelId: videoModel.id, generationId: '..' },
      { modelId: videoModel.id, generationId: '../job-1' },
      { modelId: videoModel.id, generationId: 'job%2F1' },
      { modelId: videoModel.id, generationId: 'job#1' },
      { modelId: videoModel.id, generationId: 'job\\1' },
      { modelId: videoModel.id, generationId: 'job 1' },
      { modelId: videoModel.id, generationId: 'job\u00001' },
      { modelId: videoModel.id, generationId: 'job\n1' },
      { modelId: videoModel.id, generationId: 'job\t1' },
      { modelId: videoModel.id, generationId: 'job\u007f1' },
      { modelId: videoModel.id, generationId: 'j'.repeat(201) },
      { modelId: videoListModel.id, generationId: 'job-1' },
    ];
    for (const operation of operations) {
      const error = await experimental_getVideoStatus(videoOf(executor), { operation }).catch((e: unknown) => e);
      expect(InvalidArgumentError.isInstance(error)).toBe(true);
      expect((error as InvalidArgumentError).argument).toBe('operation');
      expect((error as Error).message).not.toContain('job/1');
    }
    expect(statusCalls).toHaveLength(0);
  });

  it('accepts generation ids that stay inside one path segment', async () => {
    const ids = ['3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c', 'task:abc.def=1', 'a+b~c', 'job.1', 'é-1', 'j'.repeat(200)];
    const { statusCalls, executor } = fakeExecutor();
    for (const generationId of ids) {
      expect(await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId } })).toMatchObject({ status: 'pending' });
    }
    expect(statusCalls.map((call) => call.generationId)).toEqual(ids);
  });

  it('keeps only playground links that point at the configured playground', async () => {
    const { executor } = fakeExecutor({ status: finished });
    const links = (await Promise.all([
      'https://playground.test/?aistate=abc',
      'https://evil.test/?aistate=abc',
      'https://playground.test.evil.test/?aistate=abc',
      'https://playground.test/../evil?aistate=abc',
      'javascript:alert(1)',
    ].map(async (playgroundUrl) => {
      const status = await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1', playgroundUrl } }) as Completed;
      return (status.providerMetadata?.picsart as { videos: Array<{ playgroundUrl?: string }> }).videos[0].playgroundUrl;
    })));
    expect(links).toEqual(['https://playground.test/?aistate=abc', undefined, undefined, undefined, undefined]);
  });

  it('rethrows the caller abort reason from a status check', async () => {
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    const { statusCalls, executor } = fakeExecutor({
      status: async () => {
        controller.abort(reason);
        throw new ApiError('Operation aborted', { status: 499, code: 'aborted' });
      },
    });
    const error = await experimental_getVideoStatus(videoOf(executor), { operation: { modelId: videoModel.id, generationId: 'job-1' }, abortSignal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(statusCalls).toHaveLength(1);
  });

  it('rethrows the caller abort reason from a start', async () => {
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    const { executor } = fakeExecutor({
      start: async () => {
        controller.abort(reason);
        throw new ApiError('Operation aborted', { status: 499, code: 'aborted' });
      },
    });
    const error = await experimental_startVideo({ model: videoOf(executor), prompt: 'steam', abortSignal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
  });

  it('reports an unknown model from a status check before checking the job', async () => {
    const { statusCalls, executor } = fakeExecutor();
    const model = createPicsartWith({ ...runtimeWith(executor), asyncOperations: true }).video('missing');
    const error = await experimental_getVideoStatus(model, { operation: { modelId: 'missing', generationId: 'job-1' } }).catch((e: unknown) => e);
    expect(NoSuchModelError.isInstance(error)).toBe(true);
    expect((error as NoSuchModelError).modelType).toBe('videoModel');
    expect(statusCalls).toHaveLength(0);
  });

  it('classifies a failed catalog lookup in a status check like a status read', async () => {
    for (const [httpStatus, retryable] of [[503, true], [403, false]] as const) {
      const { statusCalls, executor } = fakeExecutor();
      const catalog: ModelCatalog = {
        getModel: async () => { throw new PicsartCatalogError('https://catalog.test/v1/models-catalog/x', httpStatus, 'catalog unavailable'); },
        listModels: async () => [],
      };
      const model = createPicsartWith({ ...runtimeWith(executor), catalog, asyncOperations: true }).video(videoModel.id);
      const error = await experimental_getVideoStatus(model, { operation: { modelId: videoModel.id, generationId: 'job-1' }, maxRetries: 0 }).catch((e: unknown) => e);
      expect(APICallError.isInstance(error)).toBe(true);
      expect(error).toMatchObject({ isRetryable: retryable, statusCode: httpStatus, url: 'https://catalog.test/v1/models-catalog/x', data: { picsart: { generationId: 'job-1' } } });
      expect(statusCalls).toHaveLength(0);
    }
  });

  it('leaves start and status out unless the runtime enables them', () => {
    const { executor } = fakeExecutor();
    const model = createPicsartWith(runtimeWith(executor)).video(videoModel.id);
    expect(model.doStart).toBeUndefined();
    expect(model.doStatus).toBeUndefined();
    expect(model.doGenerate).toBeTypeOf('function');
  });
});

describe('Picsart video operations on an aliased model id', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  const aliasedVideo = async () => {
    for (const model of await sdkCatalog().listModels({ mode: 'video' })) {
      if (!model.params.prompt) continue;
      const alias = ALL_MODELS.find((definition) => definition.id === model.id && definition.modelId && definition.modelId !== model.id)?.modelId;
      if (alias && getModel(alias)?.id === model.id) return { alias, catalogId: model.id };
    }
    throw new Error('The installed catalog has no video model with an alias');
  };

  async function aliasedSetup() {
    const { alias, catalogId } = await aliasedVideo();
    const fake = fakeExecutor({ status: finished });
    const runtime: PicsartRuntime = { ...runtimeWith(fake.executor), catalog: sdkCatalog(), asyncOperations: true };
    return { alias, catalogId, ...fake, model: createPicsartWith(runtime).video(alias) };
  }

  it('finds an alias the catalog resolves to another id', async () => {
    const { alias, catalogId } = await aliasedVideo();
    expect((await sdkCatalog().getModel(alias))?.id).toBe(catalogId);
    expect(catalogId).not.toBe(alias);
  });

  it('starts and checks the job on the model created with the alias', async () => {
    const { alias, catalogId, model, starts, statusCalls } = await aliasedSetup();
    const { operation } = await experimental_startVideo({ model, prompt: 'steam' });
    expect((operation as { modelId: string }).modelId).toBe(alias);
    const status = await experimental_getVideoStatus(model, { operation: stored(operation) });
    expect(status.status).toBe('completed');
    expect(starts.map((start) => start.modelId)).toEqual([catalogId]);
    expect(statusCalls.map((call) => call.modelId)).toEqual([catalogId]);
  });

  it('lets generateVideo poll an aliased model to completion', async () => {
    const { model, starts, statusCalls } = await aliasedSetup();
    const result = await experimental_generateVideo({
      model,
      prompt: 'steam',
      poll: { intervalMs: 1, timeoutMs: 1000 },
      download: async () => ({ data: MP4, mediaType: 'video/mp4' }),
    });
    expect(result.videos).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(statusCalls).toHaveLength(1);
  });
});

describe('createPicsart video operations', () => {
  const savedKey = process.env.PICSART_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PICSART_API_KEY;
    else process.env.PICSART_API_KEY = savedKey;
  });

  const recordingFetch = (requests: string[]) => async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response('{}');
  };

  const promptOnlyVideo = async () => {
    const model = (await sdkCatalog().listModels({ mode: 'video' })).find(
      (candidate) => Boolean(candidate.params.prompt) && Object.entries(candidate.params).every(([key, param]) => !param.required || key === 'prompt'),
    );
    if (!model) throw new Error('No prompt-only video model in the installed catalog');
    return model;
  };

  it('offers start and status only with sdk execution', async () => {
    const requests: string[] = [];
    const sdkModel = createPicsart({ catalog: testCatalog, fetch: recordingFetch(requests) }).video(videoModel.id);
    expect(sdkModel.doStart).toBeTypeOf('function');
    expect(sdkModel.doStatus).toBeTypeOf('function');

    const serverModel = createPicsart({ execution: 'server', catalog: testCatalog, fetch: recordingFetch(requests) }).video(videoModel.id);
    expect(serverModel.doStart).toBeUndefined();
    expect(serverModel.doStatus).toBeUndefined();
    await expect(experimental_startVideo({ model: serverModel, prompt: 'steam' })).rejects.toThrow(/does not implement doStart/);
    expect(requests).toHaveLength(0);
  });

  it('reports an unknown model before it needs an API key', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ fetch: recordingFetch(requests) });
    const error = await experimental_startVideo({ model: provider.video('missing'), prompt: 'steam' }).catch((e: unknown) => e);
    expect(NoSuchModelError.isInstance(error)).toBe(true);
    expect((error as NoSuchModelError).modelType).toBe('videoModel');
    expect(requests).toHaveLength(0);
  });

  it('loads the API key only when a start or status request is made', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const model = createPicsart({ fetch: recordingFetch(requests) }).video((await promptOnlyVideo()).id);
    const startError = await experimental_startVideo({ model, prompt: 'steam' }).catch((e: unknown) => e);
    expect(LoadAPIKeyError.isInstance(startError)).toBe(true);
    const statusError = await experimental_getVideoStatus(model, { operation: { modelId: model.modelId, generationId: 'job-1' } }).catch((e: unknown) => e);
    expect(LoadAPIKeyError.isInstance(statusError)).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
