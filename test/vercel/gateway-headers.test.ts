import { ApiRunMode, createClient, getModel } from '@picsart/ai-sdk';
import { experimental_getVideoStatus, generateImage } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import type { CatalogModel } from '../../src/core/types';
import { createPicsart } from '../../src/vercel/provider';
import { imageModel, memoryCatalog } from '../fixtures/catalog';

const API = 'https://api.test';
const CATALOG = 'https://catalog.test';
const RESULT_URL = 'https://cdn.test/out.png';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const envelope = (response: Record<string, unknown>) => new Response(JSON.stringify({ response }));

function route(request: WireRequest): Response {
  if (request.url === `${CATALOG}/v1/models-catalog/${encodeURIComponent(imageModel.id)}`) return new Response(JSON.stringify({ status: 'success', response: imageModel }));
  if (request.url === `${API}/workflows/v1/models/submit`) return envelope({ id: 'job-1' });
  if (request.url === `${API}/workflows/v1/models/job-1/result`) return envelope({ status: 'COMPLETED', result: { url: RESULT_URL }, usage: { credits: 3 } });
  if (request.url === RESULT_URL) return new Response(PNG);
  return new Response('not found', { status: 404 });
}

const toRequest = (input: RequestInfo | URL, init?: RequestInit): WireRequest => ({
  method: init?.method ?? 'GET',
  url: String(input),
  headers: Object.fromEntries(new Headers(init?.headers).entries()),
});

function wire(settings: Parameters<typeof createPicsart>[0] = {}) {
  const requests: WireRequest[] = [];
  const provider = createPicsart({
    apiKey: 'test-key',
    baseURL: API,
    catalog: { url: CATALOG },
    execution: 'server',
    ...settings,
    fetch: async (input, init) => {
      const request = toRequest(input, init);
      requests.push(request);
      return route(request);
    },
  });
  return { provider, requests };
}

function stubGlobalWire() {
  const requests: WireRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = toRequest(input, init);
    requests.push(request);
    return route(request);
  });
  return requests;
}

const apiRequests = (requests: WireRequest[]) => requests.filter((request) => request.url !== RESULT_URL);

describe('Picsart gateway headers', () => {
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends platform and X-Touchpoint on the catalog, run and result requests', async () => {
    const { provider, requests } = wire();
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });
    const calls = apiRequests(requests);
    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ['GET', `${CATALOG}/v1/models-catalog/${imageModel.id}`],
      ['POST', `${API}/workflows/v1/models/submit`],
      ['GET', `${API}/workflows/v1/models/job-1/result`],
    ]);
    for (const request of calls) {
      expect(request.headers.platform, request.url).toBe('api');
      expect(request.headers['x-touchpoint'], request.url).toBe('sdk');
      expect(request.headers.authorization, request.url).toBe('Bearer test-key');
    }
  });

  it('keeps a platform header set in the provider settings, whatever its case', async () => {
    const { provider, requests } = wire({ headers: { Platform: 'custom' } });
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });
    for (const request of apiRequests(requests)) {
      expect(request.headers.platform, request.url).toBe('custom');
      expect(request.headers['x-touchpoint'], request.url).toBe('sdk');
    }
  });

  it('keeps a header set on the call, and leaves the catalog request on the defaults', async () => {
    const { provider, requests } = wire();
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug', headers: { 'x-touchpoint': 'call', PLATFORM: 'mobile' } });
    const [catalogRequest, ...picsartRequests] = apiRequests(requests);
    expect(catalogRequest.url.startsWith(CATALOG)).toBe(true);
    expect(catalogRequest.headers).toMatchObject({ platform: 'api', 'x-touchpoint': 'sdk' });
    expect(picsartRequests.length).toBeGreaterThan(0);
    for (const request of picsartRequests) expect(request.headers).toMatchObject({ platform: 'mobile', 'x-touchpoint': 'call' });
  });

  it('keeps downloads free of gateway headers and credentials', async () => {
    const { provider, requests } = wire({ headers: { 'x-app': 'demo' } });
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });
    const download = requests.find((request) => request.url === RESULT_URL);
    expect(download).toBeDefined();
    expect(download?.headers.platform).toBeUndefined();
    expect(download?.headers['x-touchpoint']).toBeUndefined();
    expect(download?.headers.authorization).toBeUndefined();
    expect(download?.headers['x-app']).toBeUndefined();
  });

  it('sends every header @picsart/ai-sdk sends on its own apiKey path, except authorization', async () => {
    const sdkRequests = stubGlobalWire();
    const client = createClient({ apiUrl: API, apiKey: 'test-key' });
    await client.apis.run('v1/models', { model: imageModel.id, params: { prompt: 'a mug' } }, { mode: ApiRunMode.ASYNC });
    expect(sdkRequests.length).toBeGreaterThan(0);
    expect(Object.keys(sdkRequests[0].headers)).toEqual(expect.arrayContaining(['platform', 'x-touchpoint']));
    vi.unstubAllGlobals();

    const ourRequests = stubGlobalWire();
    const provider = createPicsart({ apiKey: 'test-key', baseURL: API, catalog: memoryCatalog([imageModel]), execution: 'server' });
    await generateImage({ model: provider.image(imageModel.id), prompt: 'a mug' });

    for (const sdkRequest of sdkRequests) {
      const ours = ourRequests.find((request) => request.method === sdkRequest.method && request.url === sdkRequest.url);
      expect(ours, `${sdkRequest.method} ${sdkRequest.url}`).toBeDefined();
      const { authorization: _credential, ...expected } = sdkRequest.headers;
      expect(ours?.headers, `${sdkRequest.method} ${sdkRequest.url}`).toMatchObject(expected);
    }
  });

  it('sends the headers on a video status read in sdk mode', async () => {
    const model = (await sdkCatalog().listModels({ mode: 'video' })).find((candidate: CatalogModel) => getModel(candidate.id) && !getModel(candidate.id)?.editWorkflow);
    if (!model) throw new Error('The installed catalog lacks a video model without an edit workflow');
    const workflow = getModel(model.id)?.workflow;
    const requests: WireRequest[] = [];
    const provider = createPicsart({
      apiKey: 'test-key',
      baseURL: API,
      fetch: async (input, init) => {
        requests.push({ method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return envelope({ status: 'COMPLETED', result: { url: 'https://cdn.test/out.mp4' }, usage: { credits: 30 } });
      },
    });

    const status = await experimental_getVideoStatus(provider.video(model.id), { operation: { modelId: model.id, generationId: 'job-1' }, maxRetries: 0 });

    expect(status.status).toBe('completed');
    expect(requests.map((request) => request.url)).toEqual([`${API}/workflows/${workflow}/job-1/result`]);
    expect(requests[0].headers).toMatchObject({ platform: 'api', 'x-touchpoint': 'sdk', authorization: 'Bearer test-key' });
  });
});
