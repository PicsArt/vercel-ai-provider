import { createClient } from '@picsart/ai-sdk';
import { experimental_generateVideo, generateImage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createPicsart, DEFAULT_BASE_URL, DEFAULT_PLAYGROUND_URL, sdkCatalog, type CatalogModel, type MediaKind } from '../src/index';

const apiKey = process.env.PICSART_API_KEY;
const liveEnabled = Boolean(apiKey) && process.env.PICSART_LIVE === '1';
const PROMPT = 'a ceramic mug on a marble table, soft morning light';
const PRICING_BATCH = 8;

const promptOnly = (model: CatalogModel): boolean =>
  Boolean(model.params.prompt) && Object.entries(model.params).every(([key, param]) => !param.required || key === 'prompt');

function shortestDuration(model: CatalogModel): { duration?: number } {
  const duration = model.params.duration;
  if (duration?.kind === 'enum') {
    const seconds = (duration.options ?? []).map((option) => Number(option.id)).filter(Number.isFinite);
    return seconds.length > 0 ? { duration: Math.min(...seconds) } : {};
  }
  if (duration?.kind === 'range' && duration.min !== undefined) return { duration: duration.min };
  return {};
}

interface Priced {
  model: CatalogModel;
  credits: number;
}

function pricingClient(record: (failure: string) => void) {
  return createClient({
    apiUrl: DEFAULT_BASE_URL,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${apiKey}`);
      try {
        const response = await fetch(url, { ...init, headers });
        if (!response.ok) record(`HTTP ${response.status}`);
        return response;
      } catch (error) {
        record(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });
}

async function findCheapest(mode: MediaKind): Promise<Priced> {
  const failures = new Set<string>();
  const record = (failure: string): void => {
    if (failures.size < 3) failures.add(failure);
  };
  const client = pricingClient(record);
  const candidates = (await sdkCatalog().listModels({ mode })).filter(promptOnly);
  const priced: Array<{ model: CatalogModel; credits: number | null }> = [];
  for (let start = 0; start < candidates.length; start += PRICING_BATCH) {
    priced.push(...(await Promise.all(candidates.slice(start, start + PRICING_BATCH).map(async (model) => {
      const credits = await client.getCredits(model.id as never, { prompt: PROMPT, ...shortestDuration(model) } as never).catch((error: unknown) => {
        record(error instanceof Error ? error.message : String(error));
        return null;
      });
      return { model, credits };
    }))));
  }
  const [pick] = priced
    .filter((entry): entry is Priced => typeof entry.credits === 'number')
    .sort((a, b) => a.credits - b.credits);
  if (!pick) {
    const seen = failures.size > 0 ? `; first failures: ${[...failures].join('; ')}` : '';
    throw new Error(`No priced ${mode} model found among ${candidates.length} candidates (getCredits returns null when a request fails)${seen}`);
  }
  return pick;
}

const cheapestByMode = new Map<MediaKind, Promise<Priced>>();
const cheapest = (mode: MediaKind): Promise<Priced> => {
  const cached = cheapestByMode.get(mode) ?? findCheapest(mode);
  cheapestByMode.set(mode, cached);
  return cached;
};

describe.skipIf(!liveEnabled)('live Picsart generation (spends credits)', () => {
  const provider = createPicsart({ apiKey });

  it('generates the cheapest image and returns an AI Playground link', async () => {
    const pick = await cheapest('image');
    console.log(`image: ${pick.model.id}, ${pick.credits} credits`);
    const result = await generateImage({ model: provider.image(pick.model.id), prompt: PROMPT });
    expect(result.image.uint8Array.length).toBeGreaterThan(1000);
    const metadata = result.images[0].providerMetadata?.picsart as { url: string; playgroundUrl: string };
    console.log(`image url: ${metadata.url}`);
    console.log(`playground: ${metadata.playgroundUrl}`);
    expect(metadata.playgroundUrl.startsWith(DEFAULT_PLAYGROUND_URL)).toBe(true);
    expect(new URL(metadata.playgroundUrl).searchParams.get('aistate')).toBeTruthy();
    const status = await fetch(metadata.playgroundUrl).then((response) => response.status, () => 'unreachable');
    console.log(`playground HTTP status: ${status}`);
  }, 600_000);

  it('generates the cheapest short video through start and status polling', async () => {
    const pick = await cheapest('video');
    console.log(`video: ${pick.model.id}, ${pick.credits} credits`);
    const result = await experimental_generateVideo({
      model: provider.video(pick.model.id),
      prompt: PROMPT,
      ...shortestDuration(pick.model),
      poll: { intervalMs: 5000, timeoutMs: 900_000 },
    });
    expect(result.video.uint8Array.length).toBeGreaterThan(10_000);
    const [video] = (result.providerMetadata.picsart as { videos: Array<{ url: string; generationId?: string }> }).videos;
    console.log(`video generationId: ${JSON.stringify(video.generationId)}`);
    console.log(`video url: ${video.url}`);
  }, 1_200_000);

  it('reports whether the catalog service and server runner are reachable', async () => {
    const pick = await cheapest('image');
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    const catalog = await fetch(`${DEFAULT_BASE_URL}/v1/models-catalog?mode=image&limit=1`, { headers });
    const options = await fetch(`${DEFAULT_BASE_URL}/workflows/v1/models/options`, { method: 'POST', headers, body: JSON.stringify({ params: { model: pick.model.id, params: { prompt: PROMPT } } }) });
    console.log(`GET /v1/models-catalog -> ${catalog.status}`);
    console.log(`POST /workflows/v1/models/options -> ${options.status}`);
    expect([catalog.status, options.status].every((status) => status > 0)).toBe(true);
  }, 120_000);
});
