import { APICallError, InvalidArgumentError, NoSuchModelError, UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { ApiError, type ApiErrorCode } from '@picsart/ai-sdk';
import { experimental_generateVideo } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MediaExecutor } from '../../src/core/types';
import { createPicsart, createPicsartWith } from '../../src/vercel/provider';
import type { PicsartRuntime } from '../../src/vercel/runtime';
import { testCatalog, videoListModel, videoModel } from '../fixtures/catalog';
import { fakeExecutor } from '../fixtures/executor';

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const download = async () => ({ data: MP4, mediaType: 'video/mp4' });

function providerRuntime(executor: MediaExecutor): PicsartRuntime {
  return {
    catalog: testCatalog,
    executor: () => executor,
    fetch: async () => new Response(MP4),
    baseURL: 'https://api.test',
    playgroundUrl: 'https://playground.test/',
  };
}

function providerWith(executor: MediaExecutor) {
  return createPicsartWith(providerRuntime(executor));
}

const videoResult = async () => ({
  items: [{ url: 'https://cdn.test/out.mp4', metadata: { lastFrameUrl: 'https://cdn.test/last-frame.png' } }],
  generationId: 'gen-video',
  credits: 30,
});

describe('Picsart video model', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  it('maps frames, duration, resolution and options', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    const result = await experimental_generateVideo({
      model: providerWith(executor).video(videoModel.id),
      prompt: { image: 'https://cdn.test/first.png', text: 'steam rises' },
      frameImages: [{ image: 'https://cdn.test/last.png', frameType: 'last_frame' }],
      duration: 5,
      resolution: '1280x720',
      aspectRatio: 'adaptive',
      fps: 30,
      generateAudio: true,
      download,
    });
    expect(calls[0].params).toEqual({
      prompt: 'steam rises',
      aspectRatio: 'adaptive',
      resolution: '720p',
      duration: 5,
      fps: 30,
      generateAudio: true,
      startFrame: 'https://cdn.test/first.png',
      endFrame: 'https://cdn.test/last.png',
    });
    expect(result.video.uint8Array).toEqual(MP4);
    const metadata = result.providerMetadata.picsart as { videos: Array<Record<string, unknown>>; credits: number };
    expect(metadata.videos[0]).toMatchObject({ url: 'https://cdn.test/out.mp4', generationId: 'gen-video', credits: 30, metadata: { lastFrameUrl: 'https://cdn.test/last-frame.png' } });
    expect(String(metadata.videos[0].playgroundUrl)).toMatch(/^https:\/\/playground\.test\/\?aistate=/);
    expect(metadata.credits).toBe(30);
  });

  it('routes a start image and a video reference', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    await experimental_generateVideo({
      model: providerWith(executor).video(videoListModel.id),
      prompt: { image: 'https://cdn.test/subject.png', text: 'dance like the clip' },
      inputReferences: [{ data: 'https://cdn.test/motion.mp4', mediaType: 'video/mp4' }],
      download,
    });
    expect(calls[0].params).toEqual({ prompt: 'dance like the clip', imageUrls: ['https://cdn.test/subject.png'], videoUrl: 'https://cdn.test/motion.mp4' });
  });

  it('routes image and video references to their own params', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    await experimental_generateVideo({
      model: providerWith(executor).video(videoListModel.id),
      prompt: 'restyle the clip',
      inputReferences: [
        { data: 'https://cdn.test/style.png', mediaType: 'image/png' },
        { data: 'https://cdn.test/motion.mp4', mediaType: 'video/mp4' },
      ],
      download,
    });
    expect(calls[0].params).toEqual({ prompt: 'restyle the clip', imageUrls: ['https://cdn.test/style.png'], videoUrl: 'https://cdn.test/motion.mp4' });
  });

  it('warns about unsupported settings', async () => {
    const { executor } = fakeExecutor({ generate: videoResult });
    const result = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', duration: 20, download });
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'unsupported', feature: 'duration' }));
  });

  it('rejects byte frames without calling Picsart', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    const error = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: { image: PNG, text: 'x' }, download }).catch((e: unknown) => e);
    expect(UnsupportedFunctionalityError.isInstance(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('never retries a failed Picsart job', async () => {
    const { calls, executor } = fakeExecutor({ generate: async () => { throw new ApiError('Internal error', { status: 503, code: 'unavailable' as ApiErrorCode }); } });
    const error = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', download }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps the media type of the downloaded file', async () => {
    const { executor } = fakeExecutor({ generate: videoResult });
    const result = await experimental_generateVideo({
      model: providerWith(executor).video(videoModel.id),
      prompt: 'steam',
      download: async () => ({ data: MP4, mediaType: 'video/quicktime' }),
    });
    expect(result.video.mediaType).toBe('video/quicktime');
  });

  it('makes one Picsart job per video', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    const result = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', n: 2, download });
    expect(calls).toHaveLength(2);
    expect(result.videos).toHaveLength(2);
  });

  it('keeps the credits of each Picsart job with its video', async () => {
    const credits = [30, 45];
    const { executor } = fakeExecutor({
      generate: async (_call, index) => ({ items: [{ url: `https://cdn.test/${index}.mp4` }], generationId: `gen-${index}`, credits: credits[index - 1], balance: 100 - index }),
    });
    const result = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', n: 2, download });
    const videos = (result.providerMetadata.picsart as { videos: Array<Record<string, unknown>> }).videos;
    expect(videos.map((video) => [video.generationId, video.credits])).toEqual([['gen-1', 30], ['gen-2', 45]]);
    expect(videos.some((video) => 'balance' in video)).toBe(false);
  });

  it('never retries a retryable API call error', async () => {
    const { calls, executor } = fakeExecutor({ generate: async () => { throw new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 503 }); } });
    const error = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', maxRetries: 2, download }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect((error as APICallError).statusCode).toBe(503);
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
    const error = await experimental_generateVideo({ model: providerWith(executor).video(videoModel.id), prompt: 'steam', abortSignal: controller.signal, download }).catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('applies the provider generation limit to a direct call', async () => {
    const { calls, executor } = fakeExecutor({ generate: videoResult });
    const runtime: PicsartRuntime = { ...providerRuntime(executor), limits: { maxGenerations: 1 } };
    const error = await createPicsartWith(runtime).video(videoModel.id).doGenerate!({
      prompt: 'steam', n: 2, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined,
      image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: undefined, providerOptions: {},
    }).then(() => undefined, (e: unknown) => e);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('n');
    expect(calls).toHaveLength(0);
  });
});

describe('createPicsart video models', () => {
  const savedKey = process.env.PICSART_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PICSART_API_KEY;
    else process.env.PICSART_API_KEY = savedKey;
  });

  it('reports an unknown model before it needs an API key', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const error = await experimental_generateVideo({ model: provider.video('missing'), prompt: 'steam', download }).catch((e: unknown) => e);
    expect(NoSuchModelError.isInstance(error)).toBe(true);
    expect((error as NoSuchModelError).modelType).toBe('videoModel');
    expect(requests).toHaveLength(0);
  });

  it('rejects byte frames before it needs an API key', async () => {
    delete process.env.PICSART_API_KEY;
    const requests: string[] = [];
    const provider = createPicsart({ catalog: testCatalog, fetch: async (input) => { requests.push(String(input)); return new Response('{}'); } });
    const error = await experimental_generateVideo({ model: provider.video(videoModel.id), prompt: { image: PNG, text: 'x' }, download }).catch((e: unknown) => e);
    expect(UnsupportedFunctionalityError.isInstance(error)).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
