import { APICallError } from '@ai-sdk/provider';
import { ALL_MODELS, ApiError, createClient, type ApiErrorCode, type ApiRunOptions, type SdkTransport } from '@picsart/ai-sdk';
import { experimental_generateVideo, generateImage } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { serverExecutor, type ServerRunner } from '../../src/core/executors';
import type { MediaKind } from '../../src/core/types';
import { createPicsart, createPicsartWith } from '../../src/vercel/provider';
import type { PicsartRuntime } from '../../src/vercel/runtime';
import { imageModel, testCatalog, videoModel } from '../fixtures/catalog';

const API = 'https://api.test';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);

async function sdkPollOptions(kind: MediaKind) {
  const model = (await sdkCatalog().listModels({ mode: kind })).find((candidate) => {
    const definition = ALL_MODELS.find((entry) => entry.id === candidate.id);
    return definition && !definition.pollOptions && !definition.syncExecute
      && Boolean(candidate.params.prompt) && Object.entries(candidate.params).every(([key, param]) => !param.required || key === 'prompt');
  });
  if (!model) throw new Error(`No prompt-only ${kind} model on the default poll settings in the installed catalog`);
  const seen: unknown[] = [];
  const transport: SdkTransport = {
    execute: async () => { throw new Error('not an async run'); },
    submit: async () => 'job-1',
    poll: async (_handle, options) => {
      seen.push(options);
      throw new Error('stop after the first poll');
    },
  };
  await createClient({ transport }).generate(model.id as never, { prompt: 'p' } as never).catch(() => undefined);
  expect(seen).toHaveLength(1);
  return seen[0] as { intervalMs: number; maxAttempts: number };
}

function recordingRunner(respond: ServerRunner['run'] = async () => ({ result: { url: 'https://cdn.test/out' } })) {
  const runs: Array<{ api: string; options: ApiRunOptions | undefined }> = [];
  const runner: ServerRunner = {
    run: async (api, payload, options) => {
      runs.push({ api, options });
      return respond(api, payload, options);
    },
  };
  return { runner, runs };
}

function serverRuntime(runner: ServerRunner): PicsartRuntime {
  return {
    catalog: testCatalog,
    executor: () => serverExecutor(runner),
    fetch: async () => new Response(PNG),
    baseURL: API,
    playgroundUrl: false,
  };
}

const failAfterAccepting: ServerRunner['run'] = async (_api, _payload, options) => {
  await options?.onAccepted?.('task-9');
  throw new ApiError('Generation failed', { status: 500, code: 'internal_error' as ApiErrorCode });
};

describe('server execution', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  it.each(['image', 'video'] as const)('polls a %s run as long as @picsart/ai-sdk does', async (kind) => {
    const expected = await sdkPollOptions(kind);
    const { runner, runs } = recordingRunner();
    await serverExecutor(runner).generate('m', { prompt: 'p' }, { kind });
    expect(runs).toHaveLength(1);
    expect(runs[0].options).toMatchObject({ mode: 'ASYNC', pollingInterval: expected.intervalMs, retriesCount: expected.maxAttempts });
  });

  it('passes the media kind of the model through generateImage and generateVideo', async () => {
    const image = await sdkPollOptions('image');
    const video = await sdkPollOptions('video');
    const { runner, runs } = recordingRunner();
    const provider = createPicsartWith(serverRuntime(runner));
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });
    await experimental_generateVideo({ model: provider.video(videoModel.id), prompt: 'steam', download: async () => ({ data: MP4, mediaType: 'video/mp4' }) });
    expect(runs.map((run) => [run.options?.pollingInterval, run.options?.retriesCount])).toEqual([
      [image.intervalMs, image.maxAttempts],
      [video.intervalMs, video.maxAttempts],
    ]);
  });

  it('keeps the accepted task id when the run then fails', async () => {
    const error = await serverExecutor({ run: failAfterAccepting }).generate('m', {}, { kind: 'video' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ generationId: 'task-9', message: 'Generation failed' });
  });

  it('uses the accepted task id when the result has none', async () => {
    const executor = serverExecutor({
      run: async (_api, _payload, options) => {
        await options?.onAccepted?.('task-9');
        return { result: { url: 'https://cdn.test/out' }, usage: { credits: 2 } };
      },
    });
    expect(await executor.generate('m', {}, { kind: 'image' })).toEqual({ items: [{ url: 'https://cdn.test/out' }], generationId: 'task-9', credits: 2 });
  });

  it.each([
    ['image', (provider: ReturnType<typeof createPicsartWith>) => generateImage({ model: provider.image(imageModel.id), prompt: 'a mug', maxRetries: 2 })],
    ['video', (provider: ReturnType<typeof createPicsartWith>) => experimental_generateVideo({ model: provider.video(videoModel.id), prompt: 'steam', maxRetries: 2 })],
  ] as const)('reports the accepted task id of a failed %s run without retrying it', async (_kind, run) => {
    const { runner, runs } = recordingRunner(failAfterAccepting);
    const error = await run(createPicsartWith(serverRuntime(runner))).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false, statusCode: 500, data: { code: 'internal_error', picsart: { generationId: 'task-9' } } });
    expect(runs).toHaveLength(1);
  });

  it('reports the task id of a failed run on the wire', async () => {
    const requests: string[] = [];
    const provider = createPicsart({
      apiKey: 'test-key',
      baseURL: API,
      catalog: testCatalog,
      execution: 'server',
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === `${API}/workflows/v1/models/submit`) return new Response(JSON.stringify({ response: { id: 'task-9' } }));
        return new Response(JSON.stringify({ status: 'error', message: 'worker crashed' }), { status: 500 });
      },
    });
    const error = await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false, statusCode: 500, data: { picsart: { generationId: 'task-9' } } });
    expect(requests).toEqual([`${API}/workflows/v1/models/submit`, `${API}/workflows/v1/models/task-9/result`]);
  });
});
