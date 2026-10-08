import { inspect } from 'node:util';
import { AISDKError, InvalidArgumentError } from '@ai-sdk/provider';
import { SerializationError, WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@ai-sdk/provider-utils';
import { getModel } from '@picsart/ai-sdk';
import { experimental_generateVideo, experimental_getVideoStatus, generateImage } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { DEFAULT_PLAYGROUND_URL } from '../../src/core/playground';
import type { CatalogModel } from '../../src/core/types';
import { PicsartImageModel } from '../../src/vercel/image-model';
import { picsart } from '../../src';
import { createPicsart, createPicsartWith, DEFAULT_BASE_URL, type PicsartProvider } from '../../src/vercel/provider';
import type { PicsartRuntime } from '../../src/vercel/runtime';
import { PicsartVideoModel } from '../../src/vercel/video-model';
import { imageModel, memoryCatalog, testCatalog, videoModel } from '../fixtures/catalog';
import { fakeExecutor } from '../fixtures/executor';

const API = 'https://api.test';
const CATALOG = 'https://catalog.test';
const API_KEY = 'secret-key-123';
const ENV_KEY = 'env-key-456';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);

interface Payload {
  modelId: string;
  config: Record<string, unknown>;
}

interface Subject {
  kind: string;
  create(provider: PicsartProvider): object;
  serialize(model: object): Payload;
  deserialize(payload: Payload): object;
  isInstance(value: unknown): boolean;
}

const subjects: Subject[] = [
  {
    kind: 'image',
    create: (provider) => provider.image(imageModel.id),
    serialize: (model) => PicsartImageModel[WORKFLOW_SERIALIZE](model as PicsartImageModel),
    deserialize: (payload) => PicsartImageModel[WORKFLOW_DESERIALIZE](payload as never),
    isInstance: (value) => value instanceof PicsartImageModel,
  },
  {
    kind: 'video',
    create: (provider) => provider.video(videoModel.id),
    serialize: (model) => PicsartVideoModel[WORKFLOW_SERIALIZE](model as PicsartVideoModel),
    deserialize: (payload) => PicsartVideoModel[WORKFLOW_DESERIALIZE](payload as never),
    isInstance: (value) => value instanceof PicsartVideoModel,
  },
];

const throughJson = (payload: Payload): Payload => JSON.parse(JSON.stringify(payload));

function withEnvKey<T>(value: string | undefined, run: () => T): T {
  const saved = process.env.PICSART_API_KEY;
  if (value === undefined) delete process.env.PICSART_API_KEY;
  else process.env.PICSART_API_KEY = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.PICSART_API_KEY;
    else process.env.PICSART_API_KEY = saved;
  }
}

const LEAK_KEY = 'env-leak-key-789';

const droppedHeaders: Array<{ label: string; headers: Record<string, string>; apiKey?: string }> = [
  { label: 'authorization', headers: { Authorization: 'plain-value' } },
  { label: 'x-api-key', headers: { 'X-API-KEY': 'plain-value' } },
  { label: 'cookie', headers: { Cookie: 'plain-value' } },
  { label: 'proxy-authorization', headers: { 'Proxy-Authorization': 'plain-value' } },
  { label: 'x-auth-token', headers: { 'x-auth-token': 'plain-value' } },
  { label: 'x-access-token', headers: { 'x-access-token': 'plain-value' } },
  { label: 'api-key', headers: { 'api-key': 'plain-value' } },
  { label: 'x-session-id', headers: { 'x-session-id': 'plain-value' } },
  { label: 'a name with secret', headers: { 'x-client-secret': 'plain-value' } },
  { label: 'a name with password', headers: { 'x-password': 'plain-value' } },
  { label: 'a name with credential', headers: { 'x-credentials': 'plain-value' } },
  { label: 'a name with signature', headers: { 'x-signature': 'plain-value' } },
  { label: 'a name with jwt', headers: { 'x-jwt': 'plain-value' } },
  { label: 'a Bearer value', headers: { 'x-forwarded': 'Bearer plain-value' } },
  { label: 'a lower-case bearer value', headers: { 'x-forwarded': 'bearer plain-value' } },
  { label: 'a Basic value', headers: { 'x-forwarded': 'BASIC plain-value' } },
  { label: 'a Bearer value with leading whitespace', headers: { 'x-forwarded': '  Bearer plain-value' } },
  { label: 'the apiKey setting inside a value', headers: { 'x-trace': `trace-${API_KEY}-1` }, apiKey: API_KEY },
  { label: 'the environment key inside a value', headers: { 'x-trace': `trace-${LEAK_KEY}-1` } },
  { label: 'the environment key as the whole value', headers: { 'x-trace': LEAK_KEY } },
  { label: 'the environment key next to an apiKey setting', headers: { 'x-trace': `trace-${LEAK_KEY}-1` }, apiKey: API_KEY },
];

const credentialUrls: Array<[string, Parameters<typeof createPicsart>[0], string]> = [
  ['userinfo in baseURL', { baseURL: 'https://user:url-secret@api.test' }, 'url-secret'],
  ['a user name in baseURL', { baseURL: 'https://url-secret@api.test' }, 'url-secret'],
  ['userinfo in catalog.url', { catalog: { url: 'https://user:url-secret@catalog.test' } }, 'url-secret'],
  ['userinfo in playgroundUrl', { playgroundUrl: 'https://user:url-secret@playground.test/' }, 'url-secret'],
  ['the apiKey setting in baseURL', { apiKey: API_KEY, baseURL: `https://api.test/?key=${API_KEY}` }, API_KEY],
  ['the apiKey setting in catalog.url', { apiKey: API_KEY, catalog: { url: `https://catalog.test/${API_KEY}` } }, API_KEY],
  ['the environment key in baseURL', { baseURL: `https://api.test/k/${LEAK_KEY}` }, LEAK_KEY],
  ['the environment key in playgroundUrl', { playgroundUrl: `https://playground.test/?k=${LEAK_KEY}` }, LEAK_KEY],
  ['a token query parameter in baseURL', { baseURL: 'https://api.test/?token=query-secret' }, 'query-secret'],
  ['an api_key query parameter in catalog.url', { catalog: { url: 'https://catalog.test/?api_key=query-secret' } }, 'query-secret'],
  ['an X-Amz-Signature query parameter in catalog.url', { catalog: { url: 'https://catalog.test/?X-Amz-Signature=query-secret' } }, 'query-secret'],
  ['a Bearer value in a playgroundUrl query parameter', { playgroundUrl: 'https://playground.test/?h=Bearer%20query-secret' }, 'query-secret'],
  ['an access_token in the playgroundUrl fragment', { playgroundUrl: 'https://playground.test/#access_token=query-secret' }, 'query-secret'],
];

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function secretProvider(overrides: Parameters<typeof createPicsart>[0] = {}) {
  return createPicsart({
    apiKey: API_KEY,
    headers: { 'x-app': 'demo', Authorization: 'Bearer leaked' },
    catalog: { url: 'https://catalog.test', ttlMs: 5 },
    execution: 'server',
    playgroundUrl: false,
    maxGenerationsPerCall: 8,
    maxConcurrentJobs: 2,
    ...overrides,
  });
}

describe.each(subjects)('$kind model serialization', (subject) => {
  it('serializes settings without credentials, through a JSON round trip', () => {
    const payload = subject.serialize(subject.create(secretProvider()));
    const restored = throughJson(payload);
    expect(restored).toEqual(payload);
    expect(restored).toEqual({
      modelId: subject.kind === 'image' ? imageModel.id : videoModel.id,
      config: {
        baseURL: DEFAULT_BASE_URL,
        headers: { 'x-app': 'demo' },
        catalog: { url: 'https://catalog.test', ttlMs: 5 },
        execution: 'server',
        playgroundUrl: false,
        maxGenerationsPerCall: 8,
        maxConcurrentJobs: 2,
      },
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain(API_KEY);
    expect(json).not.toContain('leaked');
    expect(json).not.toMatch(/authorization/i);
  });

  it('serializes the defaults without needing an API key', () => {
    const saved = process.env.PICSART_API_KEY;
    delete process.env.PICSART_API_KEY;
    try {
      const { config } = subject.serialize(subject.create(createPicsart()));
      expect(config).toEqual({ baseURL: DEFAULT_BASE_URL, catalog: 'sdk', execution: 'sdk', playgroundUrl: DEFAULT_PLAYGROUND_URL });
    } finally {
      if (saved !== undefined) process.env.PICSART_API_KEY = saved;
    }
  });

  it.each(droppedHeaders)('drops a header by $label and keeps the rest', ({ headers, apiKey }) => {
    const provider = createPicsart({ apiKey, headers: { ...headers, 'x-app': 'demo' } });
    const payload = withEnvKey(LEAK_KEY, () => subject.serialize(subject.create(provider)));
    expect(payload.config.headers).toEqual({ 'x-app': 'demo' });
    const json = JSON.stringify(payload);
    for (const value of Object.values(headers)) expect(json).not.toContain(value);
  });

  it('keeps caller headers and the API key out of the model state', () => {
    const model = subject.create(createPicsart({ apiKey: API_KEY, headers: { Authorization: 'Bearer proxy-token-123', 'x-app': 'demo' } }));
    for (const text of [JSON.stringify(model), inspect(model, { depth: 10 }), inspect(model, { depth: 10, showHidden: true })]) {
      expect(text).not.toContain('proxy-token-123');
      expect(text).not.toContain(API_KEY);
    }
  });

  it.each(credentialUrls)('refuses to serialize %s', (_label, settings, secret) => {
    const provider = withEnvKey(undefined, () => createPicsart(settings));
    const error = withEnvKey(LEAK_KEY, () => thrown(() => subject.serialize(subject.create(provider))));
    expect(SerializationError.isInstance(error)).toBe(true);
    expect((error as Error).message).not.toContain(secret);
  });

  it('keeps URLs whose query parameters carry no credential', () => {
    const catalog = { url: 'https://catalog.test/?region=us&mode=image' };
    const payload = withEnvKey(LEAK_KEY, () => subject.serialize(subject.create(createPicsart({ catalog }))));
    expect(payload.config.catalog).toEqual(catalog);
  });

  it('keeps headers that carry no credential by name or value', () => {
    const headers = { 'x-app': 'demo', 'X-Trace': 'on', 'x-request-origin': 'worker', 'x-note': 'sent by a Bearer of news' };
    const payload = withEnvKey(LEAK_KEY, () => subject.serialize(subject.create(createPicsart({ headers }))));
    expect(payload.config.headers).toEqual(headers);
  });

  it('leaves out headers when nothing else is left', () => {
    const provider = createPicsart({ headers: { authorization: 'a' } });
    expect(subject.serialize(subject.create(provider)).config).not.toHaveProperty('headers');
  });

  it('checks header values against the keys at serialization time', () => {
    const provider = withEnvKey(undefined, () => createPicsart({ headers: { 'x-trace': LEAK_KEY, 'x-app': 'demo' } }));
    const payload = withEnvKey(LEAK_KEY, () => subject.serialize(subject.create(provider)));
    expect(payload.config.headers).toEqual({ 'x-app': 'demo' });
  });

  it.each([['an empty environment key', '', undefined], ['an empty apiKey setting', undefined, '']])('skips the key check for %s', (_label, envKey, apiKey) => {
    const provider = createPicsart({ apiKey, headers: { 'x-app': 'demo' } });
    const payload = withEnvKey(envKey, () => subject.serialize(subject.create(provider)));
    expect(payload.config.headers).toEqual({ 'x-app': 'demo' });
  });

  it.each([
    ['a provider with no apiKey setting', () => createPicsart()],
    ['the default picsart provider', () => picsart],
  ])('never writes the environment key into the payload of %s', (_label, make) => {
    const payload = withEnvKey(LEAK_KEY, () => subject.serialize(subject.create(make())));
    expect(JSON.stringify(payload)).not.toContain(LEAK_KEY);
    expect(payload.config).not.toHaveProperty('apiKey');
  });

  it('keeps only the documented settings and the trimmed base URL', () => {
    const provider = createPicsart({ baseURL: `${API}/`, catalog: { url: CATALOG }, execution: 'sdk', playgroundUrl: 'https://playground.test/' });
    const { config } = subject.serialize(subject.create(provider));
    expect(config).toEqual({ baseURL: API, catalog: { url: CATALOG }, execution: 'sdk', playgroundUrl: 'https://playground.test/' });
  });

  it('refuses to serialize a model whose provider uses a custom catalog object', () => {
    const provider = createPicsart({ apiKey: API_KEY, catalog: memoryCatalog([imageModel]) });
    const error = thrown(() => subject.serialize(subject.create(provider)));
    expect(SerializationError.isInstance(error)).toBe(true);
    expect((error as Error).message).toMatch(/catalog: \{ url, ttlMs \}/);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('drops a custom fetch while still serializing', () => {
    const provider = createPicsart({ apiKey: API_KEY, fetch: async () => new Response('{}') });
    const payload = subject.serialize(subject.create(provider));
    expect(Object.keys(payload.config).sort()).toEqual(['baseURL', 'catalog', 'execution', 'playgroundUrl']);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(API_KEY);
    expect(json).not.toContain('Response');
  });

  it('refuses a model built from a hand-made runtime', () => {
    const { executor } = fakeExecutor();
    const runtime: PicsartRuntime = { catalog: testCatalog, executor: () => executor, fetch: async () => new Response('{}'), baseURL: API, playgroundUrl: false };
    const error = (() => {
      try {
        subject.serialize(subject.create(createPicsartWith(runtime)));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(AISDKError.isInstance(error)).toBe(true);
    expect((error as Error).message).toMatch(/createPicsart/);
  });

  it('deserializes to the same class, id, provider and specification version', () => {
    const original = subject.create(secretProvider()) as PicsartImageModel | PicsartVideoModel;
    const restored = subject.deserialize(throughJson(subject.serialize(original))) as PicsartImageModel | PicsartVideoModel;
    expect(subject.isInstance(restored)).toBe(true);
    expect(restored.constructor).toBe(original.constructor);
    expect(restored.modelId).toBe(original.modelId);
    expect(restored.provider).toBe(original.provider);
    expect(restored.specificationVersion).toBe(original.specificationVersion);
  });

  it('serializes a deserialized model to the same payload', () => {
    const payload = throughJson(subject.serialize(subject.create(secretProvider({ baseURL: `${API}/` }))));
    expect(throughJson(subject.serialize(subject.deserialize(payload)))).toEqual(payload);
  });

  it('carries the limits through a round trip only when they are set', () => {
    const limited = throughJson(subject.serialize(subject.create(createPicsart({ maxGenerationsPerCall: 8, maxConcurrentJobs: 2 }))));
    expect(limited.config).toMatchObject({ maxGenerationsPerCall: 8, maxConcurrentJobs: 2 });
    expect(throughJson(subject.serialize(subject.deserialize(limited)))).toEqual(limited);

    const oneLimit = throughJson(subject.serialize(subject.create(createPicsart({ maxConcurrentJobs: 3 }))));
    expect(oneLimit.config.maxConcurrentJobs).toBe(3);
    expect(oneLimit.config).not.toHaveProperty('maxGenerationsPerCall');
    expect(throughJson(subject.serialize(subject.deserialize(oneLimit)))).toEqual(oneLimit);

    const { config } = subject.serialize(subject.create(createPicsart()));
    expect(config).not.toHaveProperty('maxGenerationsPerCall');
    expect(config).not.toHaveProperty('maxConcurrentJobs');
  });
});

interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function stubWire(route: (request: WireRequest) => Response | undefined) {
  const requests: WireRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: WireRequest = { method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    requests.push(request);
    return route(request) ?? new Response('not found', { status: 404 });
  });
  return requests;
}

const catalogResponse = (model: CatalogModel) => new Response(JSON.stringify({ status: 'success', response: model }));
const envelope = (response: Record<string, unknown>) => new Response(JSON.stringify({ response }));

function serverRoute(model: CatalogModel, resultUrl: string, bytes: Uint8Array<ArrayBuffer>) {
  return (request: WireRequest): Response | undefined => {
    if (request.url === `${CATALOG}/v1/models-catalog/${encodeURIComponent(model.id)}`) return catalogResponse(model);
    if (request.url === `${API}/workflows/v1/models/submit`) return envelope({ id: 'job-1' });
    if (request.url === `${API}/workflows/v1/models/job-1/result`) return envelope({ status: 'COMPLETED', result: { url: resultUrl }, usage: { credits: 3 } });
    if (request.url === resultUrl) return new Response(bytes);
    return undefined;
  };
}

describe('serialized models over the wire', () => {
  const savedKey = process.env.PICSART_API_KEY;
  const savedWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;
  beforeAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    globalThis.AI_SDK_LOG_WARNINGS = savedWarningLogger;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.PICSART_API_KEY;
    else process.env.PICSART_API_KEY = savedKey;
  });

  const unreachable = async (): Promise<Response> => {
    throw new Error('the serialized provider fetch must not be carried over');
  };

  function serverProvider() {
    return createPicsart({
      apiKey: API_KEY,
      baseURL: API,
      headers: { 'x-app': 'demo', Authorization: 'Bearer leaked' },
      catalog: { url: CATALOG },
      execution: 'server',
      fetch: unreachable,
    });
  }

  it('generates an image after a round trip, authorized by the environment key', async () => {
    process.env.PICSART_API_KEY = ENV_KEY;
    const resultUrl = 'https://cdn.test/out.png';
    const requests = stubWire(serverRoute(imageModel, resultUrl, PNG));
    const payload = throughJson(PicsartImageModel[WORKFLOW_SERIALIZE](serverProvider().image(imageModel.id) as PicsartImageModel));

    const restored = PicsartImageModel[WORKFLOW_DESERIALIZE](payload as never);
    const result = await generateImage({ model: restored, prompt: 'a mug' });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].uint8Array).toEqual(PNG);
    const run = requests.find((request) => request.method === 'POST' && request.url === `${API}/workflows/v1/models/submit`);
    expect(run?.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(run?.headers['x-app']).toBe('demo');
    const catalogRequest = requests.find((request) => request.url.startsWith(CATALOG));
    expect(catalogRequest?.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    const download = requests.find((request) => request.url === resultUrl);
    expect(download).toBeDefined();
    expect(download?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain(API_KEY);
    expect(JSON.stringify(requests)).not.toContain('leaked');
  });

  it('generates a video after a round trip, authorized by the environment key', async () => {
    process.env.PICSART_API_KEY = ENV_KEY;
    const resultUrl = 'https://cdn.test/out.mp4';
    const requests = stubWire(serverRoute(videoModel, resultUrl, MP4));
    const payload = throughJson(PicsartVideoModel[WORKFLOW_SERIALIZE](serverProvider().video(videoModel.id) as PicsartVideoModel));

    const restored = PicsartVideoModel[WORKFLOW_DESERIALIZE](payload as never);
    const downloads: string[] = [];
    const result = await experimental_generateVideo({
      model: restored,
      prompt: 'steam',
      download: async ({ url }) => {
        downloads.push(url.href);
        return { data: MP4, mediaType: 'video/mp4' };
      },
    });

    expect(result.videos).toHaveLength(1);
    expect(downloads).toEqual([resultUrl]);
    const run = requests.find((request) => request.method === 'POST' && request.url === `${API}/workflows/v1/models/submit`);
    expect(run?.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(run?.headers['x-app']).toBe('demo');
    expect(requests.some((request) => request.url === resultUrl)).toBe(false);
    expect(JSON.stringify(requests)).not.toContain(API_KEY);
  });

  it('keeps the generation limit in a restored image model', async () => {
    process.env.PICSART_API_KEY = ENV_KEY;
    const requests = stubWire(serverRoute(imageModel, 'https://cdn.test/out.png', PNG));
    const original = createPicsart({ baseURL: API, catalog: { url: CATALOG }, execution: 'server', maxGenerationsPerCall: 2 }).image(imageModel.id) as PicsartImageModel;
    const restored = PicsartImageModel[WORKFLOW_DESERIALIZE](throughJson(PicsartImageModel[WORKFLOW_SERIALIZE](original)) as never);

    const error = await generateImage({ model: restored, prompt: 'a mug', n: 3 }).catch((e: unknown) => e);

    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    expect((error as InvalidArgumentError).argument).toBe('n');
    expect(requests).toHaveLength(0);
  });

  it('keeps asynchronous video checks in a model restored in sdk mode, and drops them in server mode', async () => {
    process.env.PICSART_API_KEY = ENV_KEY;
    const sdkModel = PicsartVideoModel[WORKFLOW_DESERIALIZE](throughJson(PicsartVideoModel[WORKFLOW_SERIALIZE](createPicsart({ baseURL: API, headers: { 'x-app': 'demo' } }).video(videoModel.id) as PicsartVideoModel)) as never) as PicsartVideoModel;
    const serverModel = PicsartVideoModel[WORKFLOW_DESERIALIZE](throughJson(PicsartVideoModel[WORKFLOW_SERIALIZE](serverProvider().video(videoModel.id) as PicsartVideoModel)) as never) as PicsartVideoModel;
    expect(typeof sdkModel.doStart).toBe('function');
    expect(typeof sdkModel.doStatus).toBe('function');
    expect(serverModel.doStart).toBeUndefined();
    expect(serverModel.doStatus).toBeUndefined();
  });

  it('reads a started video from a restored sdk-mode model with the environment key', async () => {
    process.env.PICSART_API_KEY = ENV_KEY;
    const model = (await sdkCatalog().listModels({ mode: 'video' })).find((candidate) => getModel(candidate.id) && !getModel(candidate.id)?.editWorkflow);
    if (!model) throw new Error('The installed catalog lacks a video model without an edit workflow');
    const workflow = getModel(model.id)?.workflow;
    const requests = stubWire((request) => (request.url === `${API}/workflows/${workflow}/job-1/result`
      ? envelope({ status: 'COMPLETED', result: { url: 'https://cdn.test/out.mp4' }, usage: { credits: 30 } })
      : undefined));
    const original = createPicsart({ baseURL: API, headers: { 'x-app': 'demo', cookie: 'leaked' }, fetch: unreachable }).video(model.id) as PicsartVideoModel;
    const restored = PicsartVideoModel[WORKFLOW_DESERIALIZE](throughJson(PicsartVideoModel[WORKFLOW_SERIALIZE](original)) as never);

    const status = await experimental_getVideoStatus(restored, { operation: { modelId: model.id, generationId: 'job-1' }, maxRetries: 0 });

    expect(status.status).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(requests[0].headers['x-app']).toBe('demo');
    expect(JSON.stringify(requests)).not.toContain('leaked');
  });
});
