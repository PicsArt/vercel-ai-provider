import { decodeDeepLinkPayload } from '@picsart/ai-sdk';
import { describe, expect, it } from 'vitest';
import { PicsartInputError, PicsartModelError, PicsartValidationError } from '../../src/core/errors';
import { DEFAULT_PLAYGROUND_URL } from '../../src/core/playground';
import { DEFAULT_MAX_CONCURRENT_JOBS, DEFAULT_MAX_GENERATIONS_PER_CALL, isGenerationId, mediaStatus, runMedia, startMedia } from '../../src/core/run';
import type { MediaExecutor, ModelCatalog } from '../../src/core/types';
import { imageModel, testCatalog, videoModel } from '../fixtures/catalog';
import { fakeExecutor } from '../fixtures/executor';

const VIDEO_ALIAS = 'test-video-alias';

const aliasing: ModelCatalog = {
  getModel: async (id) => testCatalog.getModel(id === VIDEO_ALIAS ? videoModel.id : id),
  listModels: (filter) => testCatalog.listModels(filter),
};

describe('runMedia', () => {
  it('splits n into the model\'s allowed counts and sums credits', async () => {
    const { calls, executor } = fakeExecutor();
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 3, prompt: 'mug' });
    expect(calls.map((call) => call.params.count)).toEqual([2, 1]);
    expect(result.items).toHaveLength(3);
    expect(result.credits).toBe(6);
    expect(result.modelId).toBe(imageModel.id);
  });

  it('sends no count to models without one', async () => {
    const { calls, executor } = fakeExecutor();
    await runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 2, prompt: 'steam' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !('count' in call.params))).toBe(true);
  });

  it('warns when batch planning replaces the caller\'s count', async () => {
    const { calls, executor } = fakeExecutor();
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 3, prompt: 'mug', extra: { count: 4 } });
    expect(calls.map((call) => call.params.count)).toEqual([2, 1]);
    expect(result.warnings).toEqual([{ type: 'unsupported', feature: 'providerOptions.picsart.count', details: expect.stringMatching(/\bn\b/) }]);
    const link = new URL(result.items[0].playgroundUrl ?? '');
    expect(decodeDeepLinkPayload(link.searchParams.get('aistate') ?? '')?.context).not.toHaveProperty('count');
  });

  it('keeps quiet when the caller\'s count is what batch planning sends', async () => {
    const { calls, executor } = fakeExecutor();
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 2, prompt: 'mug', extra: { count: 2 } });
    expect(calls.map((call) => call.params.count)).toEqual([2]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects unknown models and wrong kinds before generating', async () => {
    const { calls, executor } = fakeExecutor();
    await expect(runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: 'missing', n: 1 })).rejects.toBeInstanceOf(PicsartModelError);
    await expect(runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: imageModel.id, n: 1 })).rejects.toBeInstanceOf(PicsartModelError);
    expect(calls).toHaveLength(0);
  });

  it('stops on validation errors before generating', async () => {
    const { calls, executor } = fakeExecutor({ validate: () => ({ valid: false, errors: ['"prompt" is required'] }) });
    await expect(runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 1 })).rejects.toBeInstanceOf(PicsartValidationError);
    expect(calls).toHaveLength(0);
  });

  it('returns paid results when some batches fail', async () => {
    const { executor } = fakeExecutor({
      generate: async (call, index) => {
        if (index === 2) throw new Error('vendor timeout');
        return { items: [{ url: 'https://cdn.test/ok.png' }, { url: 'https://cdn.test/ok2.png' }], generationId: 'gen-ok', credits: 4 };
      },
    });
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 3, prompt: 'mug' });
    expect(result.items).toHaveLength(2);
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'other', message: expect.stringContaining('vendor timeout') })]);
  });

  it('keeps the batches that started when generate throws synchronously', async () => {
    let started = 0;
    const executor: MediaExecutor = {
      validate: () => ({ valid: true }),
      generate: () => {
        started += 1;
        if (started === 2) throw new Error('sync boom');
        return Promise.resolve({ items: [{ url: 'https://cdn.test/first.png' }, { url: 'https://cdn.test/first2.png' }], generationId: 'gen-first', credits: 4 });
      },
    };
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 3, prompt: 'mug' });
    expect(result.items).toHaveLength(2);
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'other', message: expect.stringContaining('sync boom') })]);
  });

  it('throws the first error when every batch fails', async () => {
    const { executor } = fakeExecutor({ generate: async () => { throw new Error('quota exceeded'); } });
    await expect(runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 1, prompt: 'mug' })).rejects.toThrow('quota exceeded');
  });

  it('adds AI Playground links that decode to the same request', async () => {
    const { executor } = fakeExecutor();
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n: 1, prompt: 'mug', aspectRatio: '16:9' });
    const link = new URL(result.items[0].playgroundUrl ?? '');
    expect(`${link.origin}${link.pathname}`).toBe(DEFAULT_PLAYGROUND_URL);
    expect(decodeDeepLinkPayload(link.searchParams.get('aistate') ?? '')?.context).toMatchObject({ prompt: 'mug', aspectRatio: '16:9' });
  });

  it('honours a custom playground URL and turning links off', async () => {
    const { executor } = fakeExecutor();
    const custom = await runMedia({ catalog: testCatalog, executor, playgroundUrl: 'https://playground.test/' }, { kind: 'image', modelId: imageModel.id, n: 1, prompt: 'mug' });
    expect(custom.items[0].playgroundUrl?.startsWith('https://playground.test/?aistate=')).toBe(true);
    const off = await runMedia({ catalog: testCatalog, executor, playgroundUrl: false }, { kind: 'image', modelId: imageModel.id, n: 1, prompt: 'mug' });
    expect(off.items[0].playgroundUrl).toBeUndefined();
  });

  it('rejects an n above the default limit before any job starts', async () => {
    const { calls, executor } = fakeExecutor();
    const error = await runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 101, prompt: 'steam' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartInputError);
    expect((error as PicsartInputError).argument).toBe('n');
    expect((error as Error).message).toContain('100');
    expect((error as Error).message).toContain('maxGenerationsPerCall');
    expect(calls).toHaveLength(0);
    expect(DEFAULT_MAX_GENERATIONS_PER_CALL).toBe(100);
  });

  it('honours a custom generation limit', async () => {
    const { calls, executor } = fakeExecutor();
    const limits = { maxGenerations: 2 };
    const error = await runMedia({ catalog: testCatalog, executor, limits }, { kind: 'image', modelId: imageModel.id, n: 3, prompt: 'mug' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartInputError);
    expect((error as PicsartInputError).argument).toBe('n');
    expect((error as Error).message).toMatch(/\b2\b/);
    expect(calls).toHaveLength(0);
    const result = await runMedia({ catalog: testCatalog, executor, limits }, { kind: 'image', modelId: imageModel.id, n: 2, prompt: 'mug' });
    expect(result.items).toHaveLength(2);
  });

  function trackedExecutor() {
    const flight = { now: 0, peak: 0 };
    const { calls, executor } = fakeExecutor({
      generate: async (_call, index) => {
        flight.now += 1;
        flight.peak = Math.max(flight.peak, flight.now);
        await new Promise((resolve) => setTimeout(resolve, 12 - index));
        flight.now -= 1;
        return { items: [{ url: `https://cdn.test/${index}.mp4` }], generationId: `gen-${index}` };
      },
    });
    return { calls, executor, flight };
  }

  it('runs at most maxConcurrentJobs jobs at once and keeps the results in order', async () => {
    const { calls, executor, flight } = trackedExecutor();
    const result = await runMedia({ catalog: testCatalog, executor, limits: { maxConcurrentJobs: 3 } }, { kind: 'video', modelId: videoModel.id, n: 10, prompt: 'steam' });
    expect(flight.peak).toBe(3);
    expect(calls).toHaveLength(10);
    expect(result.items.map((item) => item.url)).toEqual(Array.from({ length: 10 }, (_, index) => `https://cdn.test/${index + 1}.mp4`));
    expect(result.warnings).toEqual([]);
  });

  it('runs four jobs at once by default', async () => {
    const { calls, executor, flight } = trackedExecutor();
    await runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 10, prompt: 'steam' });
    expect(flight.peak).toBe(4);
    expect(calls).toHaveLength(10);
    expect(DEFAULT_MAX_CONCURRENT_JOBS).toBe(4);
  });

  it.each([0, -2, 1.5, Number.NaN])('falls back to the default concurrency for an invalid cap of %s', async (maxConcurrentJobs) => {
    const { calls, executor, flight } = trackedExecutor();
    await runMedia({ catalog: testCatalog, executor, limits: { maxConcurrentJobs } }, { kind: 'video', modelId: videoModel.id, n: 10, prompt: 'steam' });
    expect(flight.peak).toBe(DEFAULT_MAX_CONCURRENT_JOBS);
    expect(calls).toHaveLength(10);
  });

  it('starts no further jobs once the caller aborts', async () => {
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    const { calls, executor } = fakeExecutor({
      generate: async (_call, index) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (index === 1) controller.abort(reason);
        return { items: [{ url: `https://cdn.test/${index}.mp4` }], generationId: `gen-${index}` };
      },
    });
    const result = await runMedia({ catalog: testCatalog, executor, limits: { maxConcurrentJobs: 2 } }, { kind: 'video', modelId: videoModel.id, n: 10, prompt: 'steam' }, { signal: controller.signal });
    expect(calls).toHaveLength(2);
    expect(result.items.map((item) => item.url)).toEqual(['https://cdn.test/1.mp4', 'https://cdn.test/2.mp4']);
    expect(result.warnings).toEqual([{ type: 'other', message: '8 of 10 Picsart jobs failed (caller gave up). The results that succeeded are returned.' }]);
  });

  it('starts nothing and rejects with the abort reason when the signal is already aborted', async () => {
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    controller.abort(reason);
    const { calls, executor } = fakeExecutor();
    await expect(runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 3, prompt: 'steam' }, { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it('keeps the partial-failure warning when jobs run one at a time', async () => {
    const { calls, executor } = fakeExecutor({
      generate: async (_call, index) => {
        if (index === 2) throw new Error('vendor timeout');
        return { items: [{ url: `https://cdn.test/${index}.mp4` }], generationId: `gen-${index}` };
      },
    });
    const result = await runMedia({ catalog: testCatalog, executor, limits: { maxConcurrentJobs: 1 } }, { kind: 'video', modelId: videoModel.id, n: 3, prompt: 'steam' });
    expect(calls).toHaveLength(3);
    expect(result.items.map((item) => item.url)).toEqual(['https://cdn.test/1.mp4', 'https://cdn.test/3.mp4']);
    expect(result.warnings).toEqual([{ type: 'other', message: '1 of 3 Picsart jobs failed (vendor timeout). The results that succeeded are returned.' }]);
  });

  it('passes item metadata and the abort signal through', async () => {
    const controller = new AbortController();
    const { calls, executor } = fakeExecutor({
      generate: async () => ({ items: [{ url: 'https://cdn.test/v.mp4', metadata: { lastFrameUrl: 'https://cdn.test/last.png' } }], generationId: 'gen-v' }),
    });
    const result = await runMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam' }, { signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
    expect(result.items[0]).toMatchObject({ url: 'https://cdn.test/v.mp4', generationId: 'gen-v', metadata: { lastFrameUrl: 'https://cdn.test/last.png' } });
  });
});

describe('startMedia', () => {
  it('submits one job with the mapped params', async () => {
    const controller = new AbortController();
    const { calls, starts, executor } = fakeExecutor();
    const started = await startMedia(
      { catalog: testCatalog, executor, playgroundUrl: 'https://playground.test/' },
      { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam', duration: 5, resolution: '1280x720' },
      { signal: controller.signal },
    );
    expect(starts).toEqual([{ modelId: videoModel.id, params: { prompt: 'steam', duration: 5, resolution: '720p' }, signal: controller.signal }]);
    expect(calls).toHaveLength(0);
    expect(started.operation).toEqual({ modelId: videoModel.id, generationId: 'job-1', playgroundUrl: expect.stringMatching(/^https:\/\/playground\.test\/\?aistate=/) });
    expect(started.warnings).toEqual([]);
  });

  it('keeps an operation that survives JSON unchanged', async () => {
    const { executor } = fakeExecutor();
    const { operation } = await startMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam' });
    expect(JSON.parse(JSON.stringify(operation))).toEqual(operation);
    expect(Object.keys(operation).sort()).toEqual(['generationId', 'modelId', 'playgroundUrl']);
  });

  it('leaves the playground link out when links are off', async () => {
    const { executor } = fakeExecutor();
    const { operation } = await startMedia({ catalog: testCatalog, executor, playgroundUrl: false }, { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam' });
    expect(operation).toEqual({ modelId: videoModel.id, generationId: 'job-1' });
  });

  it('rejects more than one job', async () => {
    const { starts, executor } = fakeExecutor();
    const error = await startMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 2, prompt: 'steam' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartInputError);
    expect((error as PicsartInputError).argument).toBe('n');
    expect(starts).toHaveLength(0);
  });

  it('rejects any n but 1, even when one job could make them', async () => {
    const { starts, executor } = fakeExecutor();
    for (const n of [2, 0]) {
      const error = await startMedia({ catalog: testCatalog, executor }, { kind: 'image', modelId: imageModel.id, n, prompt: 'mug' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PicsartInputError);
      expect((error as PicsartInputError).argument).toBe('n');
    }
    expect(starts).toHaveLength(0);
  });

  it('applies the generation limit before starting', async () => {
    const { starts, executor } = fakeExecutor();
    const error = await startMedia({ catalog: testCatalog, executor, limits: { maxGenerations: 0 } }, { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartInputError);
    expect((error as PicsartInputError).argument).toBe('n');
    expect((error as Error).message).toContain('maxGenerationsPerCall');
    expect(starts).toHaveLength(0);
  });

  it('rejects an executor that cannot start jobs', async () => {
    const { executor } = fakeExecutor();
    const generateOnly: MediaExecutor = { validate: executor.validate, generate: executor.generate };
    const error = await startMedia({ catalog: testCatalog, executor: generateOnly }, { kind: 'video', modelId: videoModel.id, n: 1, prompt: 'steam' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartInputError);
    expect((error as Error).message).toMatch(/execution: 'sdk'/);
  });

  it('stops on validation errors before starting', async () => {
    const { starts, executor } = fakeExecutor({ validate: () => ({ valid: false, errors: ['"prompt" is required'] }) });
    await expect(startMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: videoModel.id, n: 1 })).rejects.toBeInstanceOf(PicsartValidationError);
    expect(starts).toHaveLength(0);
  });

  it('keeps the model id the caller used in the operation', async () => {
    const { starts, executor } = fakeExecutor();
    const { operation } = await startMedia({ catalog: aliasing, executor, playgroundUrl: false }, { kind: 'video', modelId: VIDEO_ALIAS, n: 1, prompt: 'steam' });
    expect(operation).toEqual({ modelId: VIDEO_ALIAS, generationId: 'job-1' });
    expect(starts.map((start) => start.modelId)).toEqual([videoModel.id]);
  });

  it('rejects unknown models and wrong kinds before starting', async () => {
    const { starts, executor } = fakeExecutor();
    await expect(startMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: 'missing', n: 1 })).rejects.toBeInstanceOf(PicsartModelError);
    await expect(startMedia({ catalog: testCatalog, executor }, { kind: 'video', modelId: imageModel.id, n: 1 })).rejects.toBeInstanceOf(PicsartModelError);
    expect(starts).toHaveLength(0);
  });
});

describe('mediaStatus', () => {
  const operation = { modelId: videoModel.id, generationId: 'job-7', playgroundUrl: 'https://playground.test/?aistate=abc' };

  it('reports a job that is still running', async () => {
    const controller = new AbortController();
    const { statusCalls, executor } = fakeExecutor();
    expect(await mediaStatus({ catalog: testCatalog, executor }, operation, { signal: controller.signal })).toEqual({ state: 'pending' });
    expect(statusCalls).toEqual([{ modelId: videoModel.id, generationId: 'job-7', signal: controller.signal }]);
  });

  it('builds the finished result from the operation', async () => {
    const { executor } = fakeExecutor({
      status: async () => ({ state: 'completed', result: { items: [{ url: 'https://cdn.test/v.mp4', metadata: { lastFrameUrl: 'https://cdn.test/last.png' } }], credits: 30, balance: 470 } }),
    });
    expect(await mediaStatus({ catalog: testCatalog, executor }, operation)).toEqual({
      state: 'completed',
      result: {
        items: [{ url: 'https://cdn.test/v.mp4', generationId: 'job-7', playgroundUrl: operation.playgroundUrl, metadata: { lastFrameUrl: 'https://cdn.test/last.png' } }],
        credits: 30,
        balance: 470,
        warnings: [],
        modelId: videoModel.id,
      },
    });
  });

  it('rejects an executor that cannot check jobs', async () => {
    const { executor } = fakeExecutor();
    const generateOnly: MediaExecutor = { validate: executor.validate, generate: executor.generate };
    await expect(mediaStatus({ catalog: testCatalog, executor: generateOnly }, operation)).rejects.toThrow(/execution: 'sdk'/);
  });

  it('checks the job under the catalog id of an aliased model', async () => {
    const { statusCalls, executor } = fakeExecutor({ status: async () => ({ state: 'completed', result: { items: [{ url: 'https://cdn.test/v.mp4' }] } }) });
    const status = await mediaStatus({ catalog: aliasing, executor }, { modelId: VIDEO_ALIAS, generationId: 'job-7' });
    expect(statusCalls.map((call) => call.modelId)).toEqual([videoModel.id]);
    expect(status).toMatchObject({ state: 'completed', result: { modelId: videoModel.id, items: [{ url: 'https://cdn.test/v.mp4', generationId: 'job-7' }] } });
  });

  it('rejects an unknown model before checking', async () => {
    const { statusCalls, executor } = fakeExecutor();
    await expect(mediaStatus({ catalog: testCatalog, executor }, { modelId: 'missing', generationId: 'job-7' })).rejects.toBeInstanceOf(PicsartModelError);
    expect(statusCalls).toHaveLength(0);
  });
});

describe('isGenerationId', () => {
  it('accepts ids that stay inside one path segment', () => {
    for (const id of ['job-1', '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c', 'task:abc.def=1', 'a+b~c', '.hidden', '...', 'é', 'a\u{1F600}b', 'j'.repeat(200)]) {
      expect(isGenerationId(id), id).toBe(true);
    }
  });

  it('rejects ids that could change the request path or query', () => {
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', 'a%2Fb', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u00a0b', 'a\uD800b', 'a\uDC00b', 'j'.repeat(201)]) {
      expect(isGenerationId(id), JSON.stringify(id)).toBe(false);
    }
    for (const value of [undefined, null, 7, {}]) expect(isGenerationId(value)).toBe(false);
  });
});
