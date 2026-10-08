import { Model } from '@picsart/ai-sdk';
import { describe, expect, it } from 'vitest';
import { remoteCatalog, sdkCatalog } from '../../src/core/catalog';
import { PicsartCatalogError } from '../../src/core/errors';

describe('sdkCatalog', () => {
  it('lists image and video models with the SDK parameter keys', async () => {
    const catalog = sdkCatalog();
    const images = await catalog.listModels({ mode: 'image' });
    const videos = await catalog.listModels({ mode: 'video' });
    expect(images.length).toBeGreaterThan(0);
    expect(videos.length).toBeGreaterThan(0);
    expect(images.every((model) => model.mode === 'image')).toBe(true);
    expect(videos.every((model) => model.mode === 'video')).toBe(true);
    for (const model of [...images, ...videos]) {
      const keys = Model(model.id).params().all().map((entry) => entry.key).sort();
      expect(Object.keys(model.params).sort(), model.id).toEqual(keys);
    }
  });

  it('lists both modes without a filter', async () => {
    const models = await sdkCatalog().listModels();
    expect(new Set(models.map((model) => model.mode))).toEqual(new Set(['image', 'video']));
  });

  it('returns undefined for an unknown model', async () => {
    expect(await sdkCatalog().getModel('no-such-model-for-tests')).toBeUndefined();
  });

  it('copies enum options and file shapes', async () => {
    const params = (await sdkCatalog().listModels()).flatMap((model) => Object.values(model.params));
    expect(params.find((param) => param.kind === 'enum')?.options?.length).toBeGreaterThan(0);
    expect(params.find((param) => param.kind === 'file')?.accept).toBeDefined();
  });
});

const base = 'https://catalog.test';
const remoteModel = {
  id: 'remote-image',
  name: 'Remote Image',
  mode: 'image',
  inputType: 't2i',
  provider: { id: 'p', name: 'P', color: '#000', label: 'P' },
  params: {
    prompt: { kind: 'text', required: true, label: 'Prompt' },
    count: { kind: 'enum', required: false, valueType: 'number', options: [{ id: 1, label: 'One' }, { id: 2 }] },
  },
};
const normalized = {
  id: 'remote-image',
  name: 'Remote Image',
  mode: 'image',
  inputType: 't2i',
  params: {
    prompt: { kind: 'text', required: true },
    count: { kind: 'enum', required: false, options: [{ id: 1 }, { id: 2 }] },
  },
};

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const fn = async (input: string): Promise<Response> => {
    calls.push(input);
    const route = routes[input];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return { calls, fn };
}

describe('remoteCatalog', () => {
  it('lists models with their schema', async () => {
    const url = `${base}/v1/models-catalog?mode=image&include=schema`;
    const { calls, fn } = fakeFetch({ [url]: { status: 200, body: { status: 'success', response: { total: 1, models: [remoteModel] } } } });
    const models = await remoteCatalog({ url: `${base}/`, fetch: fn }).listModels({ mode: 'image' });
    expect(calls).toEqual([url]);
    expect(models).toEqual([normalized]);
  });

  it('fetches one model, and returns undefined on 404', async () => {
    const url = `${base}/v1/models-catalog/remote-image`;
    const { fn } = fakeFetch({ [url]: { status: 200, body: { status: 'success', response: remoteModel } } });
    const catalog = remoteCatalog({ url: base, fetch: fn });
    expect(await catalog.getModel('remote-image')).toEqual(normalized);
    expect(await catalog.getModel('missing')).toBeUndefined();
  });

  it('throws PicsartCatalogError when the list route is not found', async () => {
    const url = `${base}/v1/models-catalog?mode=image&include=schema`;
    const { fn } = fakeFetch({});
    const error = await remoteCatalog({ url: base, fetch: fn }).listModels({ mode: 'image' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PicsartCatalogError);
    expect(error).toMatchObject({ status: 404, url });
    expect((error as Error).message).toMatch(/not found/);
    expect((error as Error).message).toContain(url);
  });

  it('caches responses until the TTL passes', async () => {
    const url = `${base}/v1/models-catalog/remote-image`;
    const { calls, fn } = fakeFetch({ [url]: { status: 200, body: { status: 'success', response: remoteModel } } });
    let now = 0;
    const catalog = remoteCatalog({ url: base, fetch: fn, ttlMs: 1000, now: () => now });
    await catalog.getModel('remote-image');
    await catalog.getModel('remote-image');
    expect(calls).toHaveLength(1);
    now = 1500;
    await catalog.getModel('remote-image');
    expect(calls).toHaveLength(2);
  });

  it('throws PicsartCatalogError on an error response, without caching it', async () => {
    const url = `${base}/v1/models-catalog/remote-image`;
    const { calls, fn } = fakeFetch({ [url]: { status: 401, body: { status: 'error', reason: 'token_error', message: 'User token was not provided or is invalid' } } });
    const catalog = remoteCatalog({ url: base, fetch: fn });
    await expect(catalog.getModel('remote-image')).rejects.toBeInstanceOf(PicsartCatalogError);
    await expect(catalog.getModel('remote-image')).rejects.toThrow(/401/);
    expect(calls).toHaveLength(2);
  });
});
