import { APICallError, InvalidArgumentError, NoSuchModelError, UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { ApiError, type ApiErrorCode } from '@picsart/ai-sdk';
import { generateImage, wrapImageModel } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { PicsartCatalogError } from '../../src/core/errors';
import type { CatalogModel, MediaExecutor, ModelCatalog } from '../../src/core/types';
import { VERSION } from '../../src/version';
import type { PicsartImageMetadata } from '../../src';
import { createPicsart, createPicsartWith } from '../../src/vercel/provider';
import type { PicsartRuntime } from '../../src/vercel/runtime';
import { editModel, imageModel, memoryCatalog, noFilesModel, promptlessModel, testCatalog } from '../fixtures/catalog';
import { fakeExecutor } from '../fixtures/executor';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function runtimeWith(executor: MediaExecutor, overrides: Partial<PicsartRuntime> = {}) {
  const downloads: string[] = [];
  const runtime: PicsartRuntime = {
    catalog: testCatalog,
    executor: () => executor,
    fetch: async (input) => {
      downloads.push(String(input));
      return new Response(PNG);
    },
    baseURL: 'https://api.test',
    playgroundUrl: 'https://playground.test/',
    ...overrides,
  };
  return { runtime, downloads };
}

describe('Picsart image model', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  it('returns downloaded bytes with Picsart metadata in one model call', async () => {
    const { calls, executor } = fakeExecutor();
    const { runtime, downloads } = runtimeWith(executor);
    const result = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug', n: 3, aspectRatio: '16:9' });
    expect(calls.map((call) => call.params.count)).toEqual([2, 1]);
    expect(result.images).toHaveLength(3);
    expect(downloads).toHaveLength(3);
    expect(result.images[0].uint8Array).toEqual(PNG);
    expect(result.images[0].mediaType).toBe('image/png');
    expect(result.calls).toHaveLength(1);
    const perImage = result.images[0].providerMetadata?.picsart as Record<string, unknown>;
    expect(perImage.url).toMatch(/^https:\/\/cdn\.test\//);
    expect(perImage.generationId).toBe('gen-1');
    expect(String(perImage.playgroundUrl)).toMatch(/^https:\/\/playground\.test\/\?aistate=/);
    const metadata = result.calls[0].providerMetadata?.picsart as PicsartImageMetadata;
    expect(metadata.credits).toBe(6);
    expect(metadata.balance).toBe(98);
    expect(metadata.images.map((image) => image.generationId)).toEqual(['gen-1', 'gen-1', 'gen-2']);
  });

  it('keeps the paid images when one of the jobs behind n fails', async () => {
    const noCountModel: CatalogModel = { id: 'test-no-count', name: 'Test No Count', mode: 'image', params: { prompt: { kind: 'text', required: true } } };
    const { calls, executor } = fakeExecutor({
      generate: async (_call, index) => {
        if (index === 2) throw new ApiError('Generation failed', { status: 500, code: 'internal_error' as ApiErrorCode });
        return { items: [{ url: `https://cdn.test/${index}.png` }], generationId: `gen-${index}`, credits: 5 };
      },
    });
    const { runtime } = runtimeWith(executor, { catalog: memoryCatalog([noCountModel]) });
    const result = await generateImage({ model: createPicsartWith(runtime).image(noCountModel.id), prompt: 'a mug', n: 3 });
    expect(calls).toHaveLength(3);
    expect(result.images).toHaveLength(2);
    expect(result.warnings).toContainEqual({ type: 'other', message: expect.stringContaining('1 of 3 Picsart jobs failed') });
    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].providerMetadata?.picsart as Record<string, unknown>).credits).toBe(10);
  });

  it('reports unsupported settings as warnings', async () => {
    const { executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor);
    const result = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug', aspectRatio: '21:9' });
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'unsupported', feature: 'aspectRatio' }));
  });

  it('rejects byte inputs without calling Picsart', async () => {
    const { calls, executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: { text: 'edit', images: [PNG] } }).catch((e: unknown) => e);
    expect(UnsupportedFunctionalityError.isInstance(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('maps unknown models to NoSuchModelError', async () => {
    const { executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image('missing'), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(NoSuchModelError.isInstance(error)).toBe(true);
  });

  it('never retries a failed Picsart job', async () => {
    const { calls, executor } = fakeExecutor({ generate: async () => { throw new ApiError('Internal error', { status: 500, code: 'internal_error' as ApiErrorCode }); } });
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect((error as APICallError).statusCode).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it('never retries a retryable API call error', async () => {
    const { calls, executor } = fakeExecutor({ generate: async () => { throw new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 503 }); } });
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug', maxRetries: 2 }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect((error as APICallError).statusCode).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an HTTP 503', async () => new Response('unavailable', { status: 503 }), 503],
    ['a network error', async (): Promise<Response> => { throw new TypeError('fetch failed'); }, undefined],
    ['a body stream failure', async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('terminated')); } })), undefined],
  ])('never retries when the result download fails with %s', async (_label, failingFetch, statusCode) => {
    const { calls, executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor, { fetch: failingFetch });
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    const failure = error as APICallError;
    expect(failure.isRetryable).toBe(false);
    expect(failure.statusCode).toBe(statusCode);
    expect(failure.data).toEqual({ picsart: { urls: ['https://cdn.test/1-0.png'], credits: 2, balance: 99 } });
    expect(calls).toHaveLength(1);
  });

  it.each(['data:image/png;base64,iVBORw0KGgo=', 'file:///tmp/out.png', 'blob:https://cdn.test/1'])('never downloads a result URL that is not http or https: %s', async (url) => {
    const { calls, executor } = fakeExecutor({ generate: async () => ({ items: [{ url }], generationId: 'gen-1', credits: 2 }) });
    const { runtime, downloads } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug', maxRetries: 2 }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect((error as APICallError).data).toEqual({ picsart: { urls: [url], credits: 2 } });
    expect(downloads).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('rethrows the caller abort reason when Picsart reports the abort', async () => {
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    const { calls, executor } = fakeExecutor({
      generate: async () => {
        controller.abort(reason);
        throw new ApiError('Operation aborted', { status: 499, code: 'aborted' as ApiErrorCode });
      },
    });
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug', abortSignal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('maps input mismatches to InvalidArgumentError', async () => {
    const { calls, executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(noFilesModel.id), prompt: { text: 'edit', images: ['https://example.com/a.png'] } }).catch((e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('files');
    expect(calls).toHaveLength(0);
  });

  it('maps executor validation failures to InvalidArgumentError', async () => {
    const { calls, executor } = fakeExecutor({ validate: () => ({ valid: false, errors: ['prompt is too long'] }) });
    const { runtime } = runtimeWith(executor);
    const error = await generateImage({ model: createPicsartWith(runtime).image(imageModel.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('providerOptions.picsart');
    expect((error as InvalidArgumentError).message).toContain('prompt is too long');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['files', 'file:///tmp/x.png'],
    ['mask', 'ftp://files.test/mask.png'],
  ])('rejects %s URLs that are not http or https', async (argument, url) => {
    const { calls, executor } = fakeExecutor();
    const { runtime } = runtimeWith(executor);
    const file = { type: 'url' as const, url };
    const model = createPicsartWith(runtime).image(imageModel.id);
    const error = await Promise.resolve(model.doGenerate({
      prompt: 'edit',
      n: 1,
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      files: argument === 'files' ? [file] : undefined,
      mask: argument === 'mask' ? file : undefined,
      providerOptions: {},
    })).catch((e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe(argument);
    expect(calls).toHaveLength(0);
  });

  describe('with a failing catalog', () => {
    const failingCatalog: ModelCatalog = {
      getModel: async () => { throw new PicsartCatalogError('https://catalog.test/models', 503, 'catalog unavailable'); },
      listModels: async () => [],
    };

    it('surfaces a non-retryable API call error from the generate call', async () => {
      const { calls, executor } = fakeExecutor();
      const provider = createPicsartWith(runtimeWith(executor, { catalog: failingCatalog }).runtime);
      const error = await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug', maxRetries: 2 }).catch((e: unknown) => e);
      expect(APICallError.isInstance(error)).toBe(true);
      expect((error as APICallError).isRetryable).toBe(false);
      expect((error as APICallError).statusCode).toBe(503);
      expect(calls).toHaveLength(0);
    });

    it('rejects the capability lookups for callers that await them', async () => {
      const { executor } = fakeExecutor();
      const image = createPicsartWith(runtimeWith(executor, { catalog: failingCatalog }).runtime).image(imageModel.id);
      const expected = { isRetryable: false, statusCode: 503 };
      await expect(Promise.resolve(image.supportsFileInputs)).rejects.toMatchObject(expected);
      await expect(Promise.resolve(image.supportsMaskInputs)).rejects.toMatchObject(expected);
    });

    it('leaves no unhandled rejection when ai reads the capability flags without awaiting them', async () => {
      const { executor } = fakeExecutor();
      const unhandled: unknown[] = [];
      const collect = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', collect);
      try {
        const model = createPicsartWith(runtimeWith(executor, { catalog: failingCatalog }).runtime).image(imageModel.id);
        wrapImageModel({ model, middleware: {} });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', collect);
      }
    });
  });

  it('takes every image of a request in one call and reads input support from the catalog', async () => {
    const { executor } = fakeExecutor();
    const provider = createPicsartWith(runtimeWith(executor).runtime);
    const image = provider.image(imageModel.id);
    expect(image.maxImagesPerCall).toBe(Number.MAX_SAFE_INTEGER);
    expect(await image.supportsFileInputs).toBe(true);
    expect(await image.supportsMaskInputs).toBe(true);
    expect(await provider.image(noFilesModel.id).supportsFileInputs).toBe(false);
    expect(await provider.image(editModel.id).supportsMaskInputs).toBe(false);
  });

  it('lists catalog models and refuses text models', async () => {
    const { executor } = fakeExecutor();
    const provider = createPicsartWith(runtimeWith(executor).runtime);
    const models = await provider.listModels({ mode: 'image' });
    expect(models.map((model) => model.id)).toContain(imageModel.id);
    expect(models.every((model) => model.mode === 'image')).toBe(true);
    expect(() => provider.languageModel('any')).toThrow(NoSuchModelError);
  });

  it('lists the required parameters other than the prompt', async () => {
    const { executor } = fakeExecutor();
    const provider = createPicsartWith(runtimeWith(executor).runtime);
    const required = Object.fromEntries((await provider.listModels({ mode: 'image' })).map((model) => [model.id, model.requiredParams]));
    expect(required[imageModel.id]).toEqual([]);
    expect(required[editModel.id]).toEqual(['startFrame']);
    expect(required[noFilesModel.id]).toEqual(['sourceImageId']);
    expect(required[promptlessModel.id]).toEqual(['imageUrls']);
  });
});

describe('createPicsart', () => {
  const savedKey = process.env.PICSART_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PICSART_API_KEY;
    else process.env.PICSART_API_KEY = savedKey;
  });

  const promptOnlyModel = async () => (await sdkCatalog().listModels({ mode: 'image' })).find(
    (model) => Boolean(model.params.prompt) && Object.entries(model.params).every(([key, param]) => !param.required || key === 'prompt'),
  );

  it('sends credentials and identity headers through the Picsart SDK', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const provider = createPicsart({
      apiKey: 'test-key',
      baseURL: 'https://api.test/',
      headers: { 'x-team': 'jedi' },
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ status: 'error', reason: 'token_error', message: 'User token was not provided or is invalid' }), { status: 401, headers: { 'content-type': 'application/json' } });
      },
    });
    const model = await promptOnlyModel();
    expect(model).toBeDefined();
    const error = await generateImage({ model: provider.image(model!.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(401);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.startsWith('https://api.test/')).toBe(true);
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-key');
    expect(requests[0].headers.get('x-team')).toBe('jedi');
    expect(requests[0].headers.get('user-agent')).toContain(`picsart-vercel-ai-provider/${VERSION}`);
  });

  it('requires an API key before calling Picsart', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const model = await promptOnlyModel();
    const error = await generateImage({ model: provider.image(model!.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AI_LoadAPIKeyError');
    expect(requests).toHaveLength(0);
  });

  it('reports an unknown model before it needs an API key', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const error = await generateImage({ model: provider.image('missing'), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(NoSuchModelError.isInstance(error)).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('sends credentials to Picsart but never to result downloads', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = createPicsart({
      apiKey: 'test-key',
      baseURL: 'https://api.test',
      headers: { 'x-team': 'jedi' },
      execution: 'server',
      catalog: testCatalog,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.endsWith('/submit')) return json({ response: { id: 'task-1' } });
        if (url.endsWith('/result')) {
          return json({ response: { status: 'COMPLETED', id: 'task-1', result: { items: [{ url: 'https://cdn.test/out.png' }] }, usage: { credits: 3 } } });
        }
        return new Response(PNG);
      },
    });
    const result = await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });
    expect(result.images).toHaveLength(1);
    const picsartRequests = requests.filter((request) => request.url.startsWith('https://api.test/'));
    expect(picsartRequests.some((request) => request.url.endsWith('/submit'))).toBe(true);
    for (const request of picsartRequests) expect(request.headers.get('authorization')).toBe('Bearer test-key');
    const downloads = requests.filter((request) => request.url === 'https://cdn.test/out.png');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].headers.has('authorization')).toBe(false);
    expect(downloads[0].headers.has('x-team')).toBe(false);
  });

  it('exposes the catalog it was configured with', async () => {
    const custom = memoryCatalog([imageModel]);
    expect(createPicsart({ catalog: custom }).catalog).toBe(custom);
    expect((await createPicsart().catalog.listModels()).map((model) => model.id)).toEqual((await sdkCatalog().listModels()).map((model) => model.id));

    const requests: Array<{ url: string; headers: Headers }> = [];
    const remote = createPicsart({
      apiKey: 'test-key',
      catalog: { url: 'https://catalog.test' },
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ status: 'success', response: { models: [imageModel] } }));
      },
    });
    expect((await remote.catalog.listModels({ mode: 'image' })).map((model) => model.id)).toEqual([imageModel.id]);
    expect(requests.map((request) => request.url)).toEqual(['https://catalog.test/v1/models-catalog?mode=image&include=schema']);
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-key');
  });

  it('reports validation failures without an API key', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const model = (await sdkCatalog().listModels({ mode: 'image' })).find((candidate) => {
      const entries = Object.entries(candidate.params);
      return Boolean(candidate.params.prompt)
        && entries.some(([, param]) => param.required && param.kind === 'file')
        && entries.every(([key, param]) => !param.required || key === 'prompt' || param.kind === 'file');
    });
    expect(model).toBeDefined();
    const error = await generateImage({ model: provider.image(model!.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('providerOptions.picsart');
    expect(requests).toHaveLength(0);
  });

  it('rejects an n above maxGenerationsPerCall before any request', async () => {
    const requests: string[] = [];
    const provider = createPicsart({ apiKey: 'test-key', catalog: testCatalog, maxGenerationsPerCall: 2, fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const error = await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug', n: 3 }).catch((e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('n');
    expect((error as Error).message).toContain('maxGenerationsPerCall');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['maxGenerationsPerCall', 0],
    ['maxGenerationsPerCall', -1],
    ['maxGenerationsPerCall', 1.5],
    ['maxGenerationsPerCall', Number.NaN],
    ['maxConcurrentJobs', 0],
    ['maxConcurrentJobs', -1],
    ['maxConcurrentJobs', 1.5],
    ['maxConcurrentJobs', Number.NaN],
  ])('rejects %s = %s', (setting, value) => {
    const error = (() => {
      try {
        createPicsart({ [setting]: value });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe(setting);
  });
});

describe('Picsart image model limits', () => {
  it('runs the jobs behind n no more than maxConcurrentJobs at a time', async () => {
    const noCountModel: CatalogModel = { id: 'test-no-count', name: 'Test No Count', mode: 'image', params: { prompt: { kind: 'text', required: true } } };
    const flight = { now: 0, peak: 0 };
    const { calls, executor } = fakeExecutor({
      generate: async (_call, index) => {
        flight.now += 1;
        flight.peak = Math.max(flight.peak, flight.now);
        await new Promise((resolve) => setTimeout(resolve, 1));
        flight.now -= 1;
        return { items: [{ url: `https://cdn.test/${index}.png` }], generationId: `gen-${index}` };
      },
    });
    const { runtime } = runtimeWith(executor, { catalog: memoryCatalog([noCountModel]), limits: { maxConcurrentJobs: 1 } });
    const result = await generateImage({ model: createPicsartWith(runtime).image(noCountModel.id), prompt: 'a mug', n: 3 });
    expect(calls).toHaveLength(3);
    expect(flight.peak).toBe(1);
    expect(result.images).toHaveLength(3);
  });
});
