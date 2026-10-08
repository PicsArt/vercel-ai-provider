import { ApiError, type AiClient, type ApiErrorCode } from '@picsart/ai-sdk';
import { describe, expect, it } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { PicsartJobFailedError, PicsartModelError } from '../../src/core/errors';
import { SERVER_MODELS_API, sdkExecutor, serverExecutor, type ServerRunner } from '../../src/core/executors';
import type { ReadOutcome } from '../../src/core/status-reads';

type SdkClient = Pick<AiClient, 'generate' | 'submit' | 'result'>;

const promptOnly = async () => (await sdkCatalog().listModels({ mode: 'image' })).find(
  (model) => Boolean(model.params.prompt) && Object.entries(model.params).every(([key, param]) => !param.required || key === 'prompt'),
);

describe('sdkExecutor', () => {
  it('validates with the installed SDK', async () => {
    const model = await promptOnly();
    expect(model).toBeDefined();
    const executor = sdkExecutor({ generate: async () => { throw new Error('not called'); } } as unknown as SdkClient);
    expect(executor.validate(model!.id, { prompt: 'a mug' })).toEqual({ valid: true });
    expect(executor.validate(model!.id, {})?.valid).toBe(false);
  });

  it('explains models the installed SDK does not know', () => {
    const executor = sdkExecutor({ generate: async () => { throw new Error('not called'); } } as unknown as SdkClient);
    expect(() => executor.validate('model-newer-than-this-sdk', {})).toThrow(PicsartModelError);
    expect(() => executor.validate('model-newer-than-this-sdk', {})).toThrow(/execution: 'server'/);
  });

  it('maps the SDK result', async () => {
    const seen: unknown[] = [];
    const client = {
      generate: async (...args: unknown[]) => {
        seen.push(args);
        return { url: 'u1', items: [{ url: 'u1', metadata: { lastFrameUrl: 'f1' } }, { url: 'u2' }], results: [], generationId: 'g1', usage: { credits: 3, balance: 10 } };
      },
    } as unknown as SdkClient;
    const signal = new AbortController().signal;
    const result = await sdkExecutor(client).generate('m', { prompt: 'p' }, { kind: 'image', signal });
    expect(seen).toEqual([['m', { prompt: 'p' }, { signal }]]);
    expect(result).toEqual({ items: [{ url: 'u1', metadata: { lastFrameUrl: 'f1' } }, { url: 'u2' }], generationId: 'g1', credits: 3, balance: 10 });
  });

  it('starts a job with submit', async () => {
    const seen: unknown[] = [];
    const client = { submit: async (...args: unknown[]) => { seen.push(args); return 'job-1'; } } as unknown as SdkClient;
    const signal = new AbortController().signal;
    expect(await sdkExecutor(client).start!('m', { prompt: 'p' }, { signal })).toEqual({ generationId: 'job-1' });
    expect(seen).toEqual([['m', { prompt: 'p' }, { signal }]]);
  });

  it('checks a job with a single poll', async () => {
    const seen: unknown[] = [];
    const client = {
      result: async (...args: unknown[]) => {
        seen.push(args);
        return { url: 'u1', items: [{ url: 'u1', metadata: { lastFrameUrl: 'f1' } }], results: [], generationId: 'job-1', usage: { credits: 30, balance: 470 } };
      },
    } as unknown as SdkClient;
    const signal = new AbortController().signal;
    const status = await sdkExecutor(client).status!('m', 'job-1', { signal });
    expect(seen).toEqual([['m', 'job-1', { maxAttempts: 1, intervalMs: 1, signal }]]);
    expect(status).toEqual({ state: 'completed', result: { items: [{ url: 'u1', metadata: { lastFrameUrl: 'f1' } }], generationId: 'job-1', credits: 30, balance: 470 } });
  });

  it('reports a poll that timed out as pending', async () => {
    const client = { result: async () => { throw new ApiError('Timed out waiting for workflow w:job-1', { status: 408, code: 'timeout' }); } } as unknown as SdkClient;
    expect(await sdkExecutor(client).status!('m', 'job-1')).toEqual({ state: 'pending' });
  });

  it('rethrows every other status error unchanged', async () => {
    const failed = new ApiError('Generation failed', { status: 422, code: 'unprocessable_entity' as ApiErrorCode });
    const otherTimeout = new ApiError('Gateway timeout', { status: 408, code: 'request_timeout' as ApiErrorCode });
    const client = { result: async (_model: string, id: string) => { throw id === 'job-1' ? failed : otherTimeout; } } as unknown as SdkClient;
    await expect(sdkExecutor(client).status!('m', 'job-1')).rejects.toBe(failed);
    await expect(sdkExecutor(client).status!('m', 'job-2')).rejects.toBe(otherTimeout);
  });
});

describe('sdkExecutor status with read outcomes', () => {
  const timeout = () => new ApiError('Timed out waiting for workflow w:job-1', { status: 408, code: 'timeout' });

  function withOutcome(outcome: ReadOutcome | undefined, error: unknown) {
    const forgotten: string[] = [];
    const client = { result: async () => { throw error; } } as unknown as SdkClient;
    const executor = sdkExecutor(client, { readOutcome: { last: () => outcome, forget: (id) => { forgotten.push(id); } } });
    return { executor, forgotten };
  }

  it('reports a job Picsart is still running as pending', async () => {
    for (const status of ['ACCEPTED', 'IN_PROGRESS'] as const) {
      const { executor } = withOutcome({ http: 200, envelope: { status, hasResult: false } }, timeout());
      expect(await executor.status!('m', 'job-1')).toEqual({ state: 'pending' });
    }
  });

  it('reports a failed job with Picsart\'s message, never the timeout text', async () => {
    const quiet = withOutcome({ http: 200, envelope: { status: 'FAILED', hasResult: false } }, timeout());
    const error = await quiet.executor.status!('m', 'job-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartJobFailedError);
    expect((error as Error).message).toBe('Picsart reported the job as failed.');
    const loud = withOutcome({ http: 200, envelope: { status: 'FAILED', hasResult: true, message: 'blocked' } }, new ApiError('Model failed (422): blocked', { status: 422, code: 'unprocessable_entity' as ApiErrorCode }));
    expect(await loud.executor.status!('m', 'job-1').catch((e: unknown) => e)).toMatchObject({ name: 'PicsartJobFailedError', message: 'blocked', modelId: 'm', generationId: 'job-1' });
  });

  it('reports a failed job even when the SDK parsed a URL', async () => {
    const forgotten: string[] = [];
    const client = { result: async () => ({ url: 'u1', items: [{ url: 'u1' }], results: [] }) } as unknown as SdkClient;
    const executor = sdkExecutor(client, { readOutcome: { last: () => ({ http: 200, envelope: { status: 'FAILED', hasResult: true } }), forget: (id) => { forgotten.push(id); } } });
    expect(await executor.status!('m', 'job-1').catch((e: unknown) => e)).toMatchObject({ name: 'PicsartJobFailedError', message: 'Picsart reported the job as failed.' });
    expect(forgotten).toEqual(['job-1']);
  });

  it('reports a finished job the SDK rejected as failed', async () => {
    const rejected = withOutcome({ http: 200, envelope: { status: 'COMPLETED', hasResult: true } }, new ApiError('Model: unexpected response - no result URL', { status: 502, code: 'invalid_response' }));
    expect(await rejected.executor.status!('m', 'job-1').catch((e: unknown) => e)).toMatchObject({ name: 'PicsartJobFailedError', message: 'Model: unexpected response - no result URL' });
    const empty = withOutcome({ http: 200, envelope: { status: 'COMPLETED', hasResult: false } }, timeout());
    expect(await empty.executor.status!('m', 'job-1').catch((e: unknown) => e)).toMatchObject({ name: 'PicsartJobFailedError', message: 'Picsart finished the job without a result.' });
  });

  it('rethrows read failures unchanged', async () => {
    const cases: Array<[ReadOutcome | undefined, unknown]> = [
      [{ http: 200 }, timeout()],
      [{ http: 503 }, new ApiError('Service unavailable', { status: 503, code: 'service_unavailable' as ApiErrorCode })],
      [{ network: true }, new ApiError('fetch failed', { status: 502, code: 'connection_error' as ApiErrorCode })],
      [undefined, timeout()],
    ];
    for (const [outcome, error] of cases) {
      const { executor } = withOutcome(outcome, error);
      await expect(executor.status!('m', 'job-1')).rejects.toBe(error);
    }
  });

  it('forgets the read once the check ends', async () => {
    const failed = withOutcome({ http: 503 }, new Error('boom'));
    await failed.executor.status!('m', 'job-1').catch(() => undefined);
    expect(failed.forgotten).toEqual(['job-1']);
    const forgotten: string[] = [];
    const client = { result: async () => ({ url: 'u1', items: [{ url: 'u1' }], results: [] }) } as unknown as SdkClient;
    await sdkExecutor(client, { readOutcome: { last: () => undefined, forget: (id) => { forgotten.push(id); } } }).status!('m', 'job-2');
    expect(forgotten).toEqual(['job-2']);
  });
});

describe('serverExecutor', () => {
  it('runs v1/models and maps items', async () => {
    const runs: unknown[] = [];
    const runner: ServerRunner = {
      run: async (api, payload, options) => {
        runs.push({ api, payload, mode: options?.mode });
        return { result: { url: 'u1', items: [{ url: 'u1' }, { url: 'u2', metadata: { exploreImageId: 'e2' } }], model: 'm' }, usage: { credits: 5 }, id: 'job-1' };
      },
    };
    const executor = serverExecutor(runner);
    expect(executor.validate('m', {})).toBeUndefined();
    expect(executor.start).toBeUndefined();
    expect(executor.status).toBeUndefined();
    const result = await executor.generate('m', { prompt: 'p' }, { kind: 'image' });
    expect(runs).toEqual([{ api: SERVER_MODELS_API, payload: { model: 'm', params: { prompt: 'p' } }, mode: 'ASYNC' }]);
    expect(result).toEqual({ items: [{ url: 'u1' }, { url: 'u2', metadata: { exploreImageId: 'e2' } }], generationId: 'job-1', credits: 5 });
  });

  it('falls back to result.url when there are no items', async () => {
    const executor = serverExecutor({ run: async () => ({ result: { url: 'only' } }) });
    expect((await executor.generate('m', {}, { kind: 'image' })).items).toEqual([{ url: 'only' }]);
  });
});
