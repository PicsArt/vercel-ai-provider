import { APICallError, type JSONValue } from '@ai-sdk/provider';
import { getModel } from '@picsart/ai-sdk';
import { experimental_generateVideo, experimental_getVideoStatus, experimental_startVideo, RetryError, type GetVideoStatusResult } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { SERVER_MODELS_API } from '../../src/core/executors';
import type { CatalogModel } from '../../src/core/types';
import { createPicsart } from '../../src/vercel/provider';
import { testCatalog, videoModel } from '../fixtures/catalog';

const BASE = 'https://api.test';
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);

interface WireRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

type Route = (request: WireRequest, index: number) => Response | Promise<Response>;

function wire(route: Route, settings: Parameters<typeof createPicsart>[0] = {}) {
  const requests: WireRequest[] = [];
  const provider = createPicsart({
    apiKey: 'test-key',
    baseURL: BASE,
    ...settings,
    fetch: async (input, init) => {
      const request = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) };
      requests.push(request);
      return route(request, requests.length);
    },
  });
  return { provider, requests };
}

const envelope = (response: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ response }), { status });

const workflows = (model: CatalogModel) => {
  const definition = getModel(model.id);
  if (!definition) throw new Error(`The installed SDK does not know ${model.id}`);
  return definition;
};

const readUrl = (workflow: string, generationId = 'job-1') => `${BASE}/workflows/${workflow}/${generationId}/result`;

async function pickVideoModels() {
  const models = await sdkCatalog().listModels({ mode: 'video' });
  const promptOnly = (model: CatalogModel) => Boolean(model.params.prompt) && Object.entries(model.params).every(([key, param]) => !param.required || key === 'prompt');
  const plain = models.find((model) => promptOnly(model) && !workflows(model).editWorkflow);
  const edited = models.find((model) => Boolean(workflows(model).editWorkflow));
  if (!plain || !edited) throw new Error('The installed catalog lacks a prompt-only video model or one with an edit workflow');
  return { plain, edited };
}

const operationFor = (model: CatalogModel): JSONValue => ({ modelId: model.id, generationId: 'job-1' });

describe('video status reads on the Picsart wire', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });

  async function statusOf(route: Route, maxRetries = 0) {
    const { plain } = await pickVideoModels();
    const { provider, requests } = wire(route);
    const result = await experimental_getVideoStatus(provider.video(plain.id), { operation: operationFor(plain), maxRetries }).catch((e: unknown) => e);
    return { result, requests, plain };
  }

  it('reports a job in progress as pending after one read', async () => {
    const { result, requests, plain } = await statusOf(() => envelope({ status: 'IN_PROGRESS', result: null }));
    expect(result).toMatchObject({ status: 'pending' });
    expect(requests.map((request) => [request.method, request.url])).toEqual([['GET', readUrl(workflows(plain).workflow)]]);
  });

  it('reports a failed job with no result as an error, not pending', async () => {
    const { result } = await statusOf(() => envelope({ status: 'FAILED', result: null }));
    expect(result).toMatchObject({ status: 'error', error: 'Picsart reported the job as failed.' });
  });

  it('reports a failed job with Picsart\'s message', async () => {
    const { result } = await statusOf(() => envelope({ status: 'FAILED', result: { message: 'blocked' } }));
    expect(result).toMatchObject({ status: 'error' });
    expect((result as { error: string }).error).toContain('blocked');
  });

  it('reports a failed job as an error even when its result has a URL', async () => {
    const { result } = await statusOf(() => envelope({ status: 'FAILED', result: { url: 'https://cdn.test/partial.mp4', message: 'cut short' } }));
    expect(result).toMatchObject({ status: 'error', error: 'cut short' });
  });

  it('returns a finished video', async () => {
    const { result } = await statusOf(() => envelope({ status: 'COMPLETED', result: { url: 'https://cdn.test/out.mp4' }, usage: { credits: 30 } }));
    const completed = result as Extract<GetVideoStatusResult, { status: 'completed' }>;
    expect(completed.status).toBe('completed');
    expect(completed.videos).toEqual([{ type: 'url', url: 'https://cdn.test/out.mp4', mediaType: 'application/octet-stream' }]);
    expect(completed.providerMetadata?.picsart).toMatchObject({ videos: [{ url: 'https://cdn.test/out.mp4', generationId: 'job-1', credits: 30 }], credits: 30 });
  });

  it('reports a finished job with a falsy result as missing its result', async () => {
    for (const result of ['', 0, false]) {
      const { result: status } = await statusOf(() => envelope({ status: 'COMPLETED', result }));
      expect(status).toMatchObject({ status: 'error', error: 'Picsart finished the job without a result.' });
    }
  });

  it('throws a retryable error for a 500 even when its body is a FAILED envelope', async () => {
    const { result } = await statusOf(() => envelope({ status: 'FAILED', result: { message: 'blocked' } }, 500));
    expect(APICallError.isInstance(result)).toBe(true);
    expect(result).toMatchObject({ isRetryable: true, statusCode: 500 });
  });

  it('reads an id with colons and dots at exactly its own result path', async () => {
    const { plain } = await pickVideoModels();
    const generationId = 'task:abc.def=1';
    const { provider, requests } = wire(() => envelope({ status: 'IN_PROGRESS' }));
    const status = await experimental_getVideoStatus(provider.video(plain.id), { operation: { modelId: plain.id, generationId }, maxRetries: 0 });
    expect(status.status).toBe('pending');
    const expected = readUrl(workflows(plain).workflow, generationId);
    expect(requests.map((request) => request.url)).toEqual([expected]);
    expect(new URL(requests[0].url).pathname).toBe(new URL(expected).pathname);
    expect(new URL(requests[0].url).pathname.endsWith(`/${generationId}/result`)).toBe(true);
  });

  it('reports a finished job with no video URL as an error', async () => {
    const { result } = await statusOf(() => envelope({ status: 'COMPLETED', result: { note: 'no video here' } }));
    expect(result).toMatchObject({ status: 'error' });
  });

  it('throws a retryable error for a 200 that is not JSON', async () => {
    const { result } = await statusOf(() => new Response('<html>gateway hiccup</html>', { status: 200 }));
    expect(APICallError.isInstance(result)).toBe(true);
    expect((result as APICallError).isRetryable).toBe(true);
  });

  it('throws a non-retryable error for a rejected key', async () => {
    const { result } = await statusOf(() => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }));
    expect(APICallError.isInstance(result)).toBe(true);
    expect(result).toMatchObject({ isRetryable: false, statusCode: 401, data: { code: 'unauthorized' } });
  });

  it('retries a read that Picsart answered with 503', async () => {
    vi.useFakeTimers();
    try {
      const { plain } = await pickVideoModels();
      const { provider, requests } = wire(() => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 }));
      const pending = experimental_getVideoStatus(provider.video(plain.id), { operation: operationFor(plain), maxRetries: 2 }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(RetryError.isInstance(error)).toBe(true);
      expect(requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a job to the edit workflow and judges it by the last read', async () => {
    const { edited } = await pickVideoModels();
    const { workflow, editWorkflow } = workflows(edited);
    const { provider, requests } = wire((request) => (request.url === readUrl(workflow)
      ? new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
      : envelope({ status: 'IN_PROGRESS' })));
    const result = await experimental_getVideoStatus(provider.video(edited.id), { operation: operationFor(edited), maxRetries: 0 });
    expect(result.status).toBe('pending');
    expect(requests.map((request) => request.url)).toEqual([readUrl(workflow), readUrl(editWorkflow!)]);
  });

  it('never reports an earlier read once a later one fails', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const { edited } = await pickVideoModels();
      for (const earlier of ['IN_PROGRESS', 'FAILED']) {
        const { provider, requests } = wire((_request, index) => {
          if (index === 1) return envelope({ status: earlier, result: null });
          throw new TypeError('fetch failed');
        });
        const error = await experimental_getVideoStatus(provider.video(edited.id), { operation: operationFor(edited), maxRetries: 0 }).catch((e: unknown) => e);
        expect(requests).toHaveLength(2);
        expect(APICallError.isInstance(error)).toBe(true);
        expect((error as APICallError).isRetryable).toBe(true);
      }
    } finally {
      debug.mockRestore();
    }
  });

  it('rethrows the caller abort reason from a read', async () => {
    const { plain } = await pickVideoModels();
    const reason = new Error('caller gave up');
    const controller = new AbortController();
    const { provider } = wire(() => {
      controller.abort(reason);
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const error = await experimental_getVideoStatus(provider.video(plain.id), { operation: operationFor(plain), abortSignal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
  });
});

describe('video starts on the Picsart wire', () => {
  it('submits once and keeps idempotency keys away from Picsart', async () => {
    const { plain } = await pickVideoModels();
    const { provider, requests } = wire(() => envelope({ id: 'job-1' }));
    const started = await experimental_startVideo({ model: provider.video(plain.id), prompt: 'steam rises', headers: { 'Idempotency-Key': 'mine', 'x-trace': 't1' } });
    expect(started.operation).toMatchObject({ modelId: plain.id, generationId: 'job-1' });
    expect(requests.map((request) => [request.method, request.url])).toEqual([['POST', `${BASE}/workflows/${workflows(plain).workflow}/submit`]]);
    expect(Object.keys(requests[0].headers).some((name) => name.toLowerCase() === 'idempotency-key')).toBe(false);
    expect(requests[0].headers['x-trace']).toBe('t1');
  });

  it('strips the idempotency key that ai adds on its own', async () => {
    const { plain } = await pickVideoModels();
    const { provider, requests } = wire(() => envelope({ id: 'job-1' }));
    await experimental_startVideo({ model: provider.video(plain.id), prompt: 'steam rises' });
    expect(Object.keys(requests[0].headers).some((name) => name.toLowerCase() === 'idempotency-key')).toBe(false);
  });

  it('never retries a start Picsart answered with 503', async () => {
    const { plain } = await pickVideoModels();
    const { provider, requests } = wire(() => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 }));
    const error = await experimental_startVideo({ model: provider.video(plain.id), prompt: 'steam', maxRetries: 2 }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false, statusCode: 503 });
    expect(requests).toHaveLength(1);
  });

  it('accepts a submitted id with colons and dots', async () => {
    const { plain } = await pickVideoModels();
    const { provider } = wire(() => envelope({ id: 'task:abc.def=1' }));
    const started = await experimental_startVideo({ model: provider.video(plain.id), prompt: 'steam' });
    expect(started.operation).toMatchObject({ generationId: 'task:abc.def=1' });
  });

  it('fails at start when Picsart returns an id it cannot check later', async () => {
    const { plain } = await pickVideoModels();
    const { provider, requests } = wire(() => envelope({ id: '../other/job' }));
    const error = await experimental_startVideo({ model: provider.video(plain.id), prompt: 'steam' }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: false, data: { picsart: { generationId: '../other/job' } } });
    expect(requests).toHaveLength(1);
  });

  it('runs generateVideo through doGenerate in server execution, even with poll', async () => {
    const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
    globalThis.AI_SDK_LOG_WARNINGS = false;
    try {
      const { provider, requests } = wire((request) => (request.method === 'POST'
        ? envelope({ id: 'srv-1' })
        : envelope({ status: 'COMPLETED', result: { url: 'https://cdn.test/out.mp4' }, usage: { credits: 30 } })), { execution: 'server', catalog: testCatalog });
      const result = await experimental_generateVideo({
        model: provider.video(videoModel.id),
        prompt: 'steam',
        poll: { intervalMs: 1, timeoutMs: 1000 },
        download: async () => ({ data: MP4, mediaType: 'video/mp4' }),
      });
      expect(result.video.uint8Array).toEqual(MP4);
      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ['POST', `${BASE}/workflows/${SERVER_MODELS_API}/submit`],
        ['GET', `${BASE}/workflows/${SERVER_MODELS_API}/srv-1/result`],
      ]);
    } finally {
      globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
    }
  });
});
